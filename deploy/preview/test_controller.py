"""Behavioral regressions for the trusted preview security/lifecycle boundary.

Run with Python 3.12+: python3 deploy/preview/test_controller.py
"""
from __future__ import annotations

from contextlib import ExitStack
from email.message import Message
import http.client
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import traceback
import unittest
from unittest import mock
import urllib.error
import urllib.request
import urllib.response


_SPEC = importlib.util.spec_from_file_location(
    "archive_preview_controller", Path(__file__).with_name("controller.py")
)
controller = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(controller)

SHA = "a" * 40
REQUIRED_FILES = {
    "backend/go.mod": b"module preview\n",
    "backend/go.sum": b"",
    "frontend/package.json": b"{}\n",
    "frontend/package-lock.json": b"{}\n",
}


def file_member(name, data=b"example", mode=0o644):
    member = tarfile.TarInfo(name)
    member.size = len(data)
    member.mode = mode
    return member, data


def source_archive(extra=()):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        for member, data in [*(file_member(name, data) for name, data in REQUIRED_FILES.items()), *extra]:
            archive.addfile(member, io.BytesIO(data) if member.isfile() else None)
    stream.seek(0)
    return stream


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.destination = self.root / "source"
        self.destination.mkdir()

    def test_extracts_regular_source_and_normalizes_executable_permissions(self):
        controller.extract_source(
            source_archive([file_member("backend/helper", b"#!/bin/sh\n", 0o4777)]),
            self.destination,
        )
        for name, data in REQUIRED_FILES.items():
            self.assertEqual((self.destination / name).read_bytes(), data)
        self.assertEqual((self.destination / "backend/helper").stat().st_mode & 0o7777, 0o755)

    def test_rejects_paths_escaping_the_source_root(self):
        for name in ("../escaped", "backend/../../escaped", str(self.root / "escaped"), "backend\\escaped"):
            with self.subTest(name=name), self.assertRaises(controller.PreviewError):
                controller.extract_source(source_archive([file_member(name)]), self.destination)
            self.assertFalse((self.root / "escaped").exists())
            # Each case needs an empty destination, not a duplicate-file failure.
            for path in sorted(self.destination.rglob("*"), reverse=True):
                path.rmdir() if path.is_dir() else path.unlink()

    def test_rejects_links_and_special_files(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE):
            member = tarfile.TarInfo("backend/unsafe")
            member.type = kind
            member.linkname = "../../escaped"
            # Put the unsafe member first so each subtest fails before writing.
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w") as archive:
                archive.addfile(member)
            stream.seek(0)
            with self.subTest(kind=kind), self.assertRaises(controller.PreviewError):
                controller.extract_source(stream, self.destination)
            self.assertFalse((self.destination / "backend/unsafe").exists())

    def test_rejects_duplicate_normalized_file_paths(self):
        for name in ("backend/go.mod", "backend/./go.mod"):
            with self.subTest(name=name):
                with tempfile.TemporaryDirectory(dir=self.root) as destination:
                    with self.assertRaises(controller.PreviewError):
                        controller.extract_source(source_archive([file_member(name)]), Path(destination))

    def test_enforces_entry_file_and_expanded_size_limits(self):
        limits = {
            "MAX_MEMBERS": len(REQUIRED_FILES) - 1,
            "MAX_FILE_BYTES": 2,
            "MAX_EXPANDED_BYTES": sum(map(len, REQUIRED_FILES.values())) - 1,
        }
        for name, limit in limits.items():
            with self.subTest(limit=name), tempfile.TemporaryDirectory(dir=self.root) as destination:
                with mock.patch.object(controller, name, limit):
                    with self.assertRaises(controller.PreviewError):
                        controller.extract_source(source_archive(), Path(destination))

    def test_counts_trailing_bytes_against_transport_limit(self):
        archive = source_archive().getvalue()
        with mock.patch.object(controller, "MAX_TAR_BYTES", len(archive) + 8):
            with self.assertRaises(controller.PreviewError):
                controller.extract_source(io.BytesIO(archive + b"x" * 16), self.destination)


class ForcedCommandTests(unittest.TestCase):
    def test_rejects_unauthorized_or_extra_tokens_before_constructing_controller(self):
        cases = [
            ("deploy", "credentials 7"),
            ("review", f"deploy 7 {SHA}"),
            ("review", "destroy 7"),
            ("deploy", ""),
            ("deploy", "sh"),
            ("deploy", "status 7 --role review"),
            ("deploy", "status 7 --config /tmp/attacker.json"),
            ("deploy", f"deploy 7 {SHA} extra"),
            ("review", "status 7 extra"),
            ("deploy", "status --role"),
            ("deploy", "status 0"),
            ("deploy", "status 40001"),
            ("deploy", f"deploy 7 {SHA.upper()}"),
            ("deploy", f"destroy 7 {SHA}"),
        ]
        for role, command in cases:
            with self.subTest(role=role, command=command), ExitStack() as stack:
                stack.enter_context(mock.patch.object(sys, "argv", ["controller.py", "--ssh", "--role", role]))
                stack.enter_context(mock.patch.dict(controller.os.environ, {"SSH_ORIGINAL_COMMAND": command}, clear=True))
                stack.enter_context(mock.patch.object(controller.os, "umask"))
                stack.enter_context(mock.patch.object(controller.signal, "signal"))
                constructor = stack.enter_context(mock.patch.object(controller, "Controller"))
                with self.assertRaises(controller.PreviewError):
                    controller.main()
                constructor.assert_not_called()


class RecordingHTTPTransport(urllib.request.HTTPHandler):
    """Exercise urllib's actual redirect/error routing without opening sockets."""
    def __init__(self, status=200, headers=(), body=b"ok", reason="OK", error=None):
        super().__init__()
        self.status, self.headers, self.body, self.reason = status, headers, body, reason
        self.error = error
        self.requests = []
        self.responses = []

    def http_open(self, request):
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        headers = Message()
        for name, value in self.headers:
            headers[name] = value
        response = urllib.response.addinfourl(io.BytesIO(self.body), headers, request.full_url, self.status)
        response.msg = self.reason
        self.responses.append(response)
        return response


class HTTPBoundaryTests(unittest.TestCase):
    def request(self, transport, **arguments):
        original_build_opener = urllib.request.build_opener
        try:
            with mock.patch.object(controller.signal, "alarm"):
                with mock.patch.object(
                    controller.urllib.request, "build_opener",
                    side_effect=lambda *handlers: original_build_opener(*handlers, transport),
                ):
                    return controller.Controller.http(object(), 7, "/health/ready", **arguments)
        finally:
            for response in transport.responses:
                response.close()
            if isinstance(transport.error, urllib.error.HTTPError):
                transport.error.close()

    def test_accepts_loopback_response_and_preserves_pr_origin(self):
        transport = RecordingHTTPTransport(body=b'{"ready":true}')
        data, _ = self.request(transport, cookie="archive_session=disposable")
        self.assertEqual(data, b'{"ready":true}')
        self.assertEqual(len(transport.requests), 1)
        request = transport.requests[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:20007/health/ready")
        self.assertEqual(request.get_header("Host"), "pr-7.localhost:20007")
        self.assertEqual(request.get_header("Origin"), "http://pr-7.localhost:20007")
        self.assertEqual(request.get_header("Cookie"), "archive_session=disposable")

    def test_never_follows_branch_redirects(self):
        for status in (301, 302, 303, 307, 308):
            for location in ("http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:22/", "/login"):
                with self.subTest(status=status, location=location):
                    transport = RecordingHTTPTransport(status, [("Location", location)])
                    with self.assertRaises(controller.PreviewError):
                        self.request(transport)
                    self.assertEqual([request.full_url for request in transport.requests],
                                     ["http://127.0.0.1:20007/health/ready"])

    def test_redacts_branch_error_reasons_including_tracebacks(self):
        secret = "disposable-root-password-must-not-leak"
        transports = [
            RecordingHTTPTransport(500, body=secret.encode(), reason=secret),
            RecordingHTTPTransport(error=urllib.error.URLError(secret)),
            RecordingHTTPTransport(error=http.client.BadStatusLine(secret)),
        ]
        for transport in transports:
            with self.subTest(error=type(transport.error).__name__):
                try:
                    self.request(transport)
                except controller.PreviewError as error:
                    self.assertNotIn(secret, str(error))
                    self.assertNotIn(secret, "".join(traceback.format_exception(error)))
                else:
                    self.fail("branch HTTP failure was accepted")


class LifecycleTests(unittest.TestCase):
    def test_failed_deployment_removes_only_its_partial_resources(self):
        for failure in ("api", "frontend", "seed"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                config = root / "config.json"
                config.write_text(controller.json.dumps({
                    "version": 1, "state_dir": str(root / "state"),
                    "docker_binary": "/usr/bin/docker", "docker_host": "unix:///run/user/1000/docker.sock",
                    "deployment_mode": "rootless",
                }))
                instance = controller.Controller(config)
                other = instance.directory(8)
                other.mkdir(mode=0o700)
                sentinel = other / "untouched"
                sentinel.write_text("another PR's source and state")
                foreign_images = {f"archive-preview-{component}:pr-8-{SHA}" for component in ("api", "frontend")}
                images = set(foreign_images)
                projects = set()
                calls = []

                def docker(arguments, **kwargs):
                    command = arguments[len(instance.docker):]
                    calls.append(command)
                    output = ""
                    code = 0
                    if command[0] == "build":
                        tag = command[command.index("--tag") + 1]
                        if tag.startswith(f"archive-preview-{failure}:"):
                            code = 1
                        else:
                            images.add(tag)
                    elif command[:2] == ["image", "ls"]:
                        tag = next(value.removeprefix("reference=") for value in command if value.startswith("reference="))
                        output = "sha256:existing\n" if tag in images else ""
                    elif command[:2] == ["image", "rm"]:
                        self.assertIn(command[2], images, "cleanup tried to remove an image that was never built")
                        images.remove(command[2])
                    elif command[0] == "compose":
                        project = command[command.index("--project-name") + 1]
                        self.assertEqual(project, f"archive-preview-pr-7-{SHA}")
                        if "up" in command:
                            projects.add(project)
                        elif "down" in command:
                            projects.discard(project)
                        else:
                            self.fail(f"unexpected compose operation: {command}")
                    else:
                        self.fail(f"unexpected Docker command: {command}")
                    return subprocess.CompletedProcess(arguments, code, stdout=output, stderr="")

                with mock.patch.object(controller.subprocess, "run", side_effect=docker):
                    with mock.patch.object(controller.signal, "alarm"):
                        with mock.patch.object(instance, "ready"), mock.patch.object(
                            instance, "seed", side_effect=controller.PreviewError("seed proof failed")
                        ):
                            with self.assertRaises(controller.PreviewError):
                                instance.deploy(7, SHA, source_archive())
                    # Repeated destroy is harmless even when no images were produced.
                    instance.remove(7)
                self.assertFalse(instance.directory(7).exists())
                self.assertEqual(instance.status(7)["status"], "absent")
                self.assertEqual(images, foreign_images)
                self.assertFalse(projects)
                self.assertEqual(sentinel.read_text(), "another PR's source and state")
                self.assertTrue(any(command[0] == "compose" and "down" in command for command in calls))
                self.assertFalse(any("prune" in command for command in calls))


if __name__ == "__main__":
    unittest.main()
