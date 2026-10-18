#!/usr/bin/env python3
"""Trusted host controller; branch files are input data, never host programs."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import http.client
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import signal
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

TRUSTED_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = Path("/etc/archive-preview/config.json")
MAX_TAR_BYTES = 256 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 20000
MAX_FILE_BYTES = 128 * 1024 * 1024
HELP = """Private Archive PR previews. Requires Python 3.12+ and Docker Compose v2.

Installed SSH deploy role accepts deploy PR SHA (uncompressed git archive on stdin),
destroy PR, status PR. Review role accepts credentials PR and status PR. SHA is
exactly 40 lowercase hex digits; PR is 1..40000; port is 20000+PR. Credentials are
NEVER emitted by deploy/status. SSH -N establishes a review tunnel without running
a command. Use ssh -N -L 127.0.0.1:PORT:127.0.0.1:PORT REVIEW_TARGET, then visit
http://pr-PR.localhost:PORT (not localhost:PORT: cookies must remain PR-specific).

Config JSON has exactly version=1, state_dir (absolute private directory),
docker_binary (absolute executable), docker_host (unix:// absolute socket), and
deployment_mode='rootless'. The installer creates it outside the state directory.
For local Docker Desktop smoke ONLY, use deployment_mode='local-docker-desktop';
the controller validates the Docker Desktop daemon rather than allowing arbitrary
rootful Linux daemons. Templates always build/run linux/amd64. Example:
  python3.12 deploy/preview/controller.py --config /tmp/preview-config.json deploy 7 SHA < source.tar
  python3.12 deploy/preview/controller.py --config /tmp/preview-config.json credentials 7
  python3.12 deploy/preview/controller.py --config /tmp/preview-config.json destroy 7

All operations serialize with private global and per-PR locks. A new deploy first
removes the old PR runtime: every push resets its disposable database/uploads.
Source archives are limited to 256MiB, 512MiB expanded, 20,000 entries, 128MiB/file;
links, special files, traversal and duplicate files are rejected. Runtime networks
are internal; only the gateway publishes, on 127.0.0.1. Builds need dependency/font
egress and run untrusted build hooks in Docker, not on the host. Rootless Docker on
a dedicated disposable host is the boundary, NOT a perfect malicious-code sandbox.
Destroy removes only this PR's resources and images, never globally prunes Docker.
"""


class PreviewError(Exception):
    pass


class PreviewInterrupted(Exception):
    """Cancellation must not be mistaken for a retryable readiness failure."""


def pr_number(value: str) -> int:
    if not re.fullmatch(r"[1-9][0-9]{0,4}", value) or not 1 <= int(value) <= 40000:
        raise argparse.ArgumentTypeError("PR must be an integer in 1..40000")
    return int(value)


def sha_value(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise argparse.ArgumentTypeError("SHA must contain exactly 40 lowercase hex digits")
    return value


def private_json(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


class LimitedReader:
    def __init__(self, stream):
        self.stream = stream
        self.total = 0

    def read(self, size=-1):
        if size < 0:
            size = MAX_TAR_BYTES + 1 - self.total
        chunk = self.stream.read(min(size, MAX_TAR_BYTES + 1 - self.total))
        self.total += len(chunk)
        if self.total > MAX_TAR_BYTES:
            raise PreviewError("archive exceeds stream size limit")
        return chunk


def extract_source(stream, destination: Path) -> None:
    """Streaming, data-filtered extraction, with no links or special files."""
    reader = LimitedReader(stream)
    seen = set()
    count = expanded = 0
    with tarfile.open(fileobj=reader, mode="r|") as archive:
        for member in archive:
            count += 1
            expanded += member.size
            name = PurePosixPath(member.name)
            if (count > MAX_MEMBERS or expanded > MAX_EXPANDED_BYTES
                    or member.size > MAX_FILE_BYTES or member.size < 0):
                raise PreviewError("archive exceeds extraction limits")
            if (not member.name or len(member.name) > 512 or name.is_absolute()
                    or ".." in name.parts or "\\" in member.name):
                raise PreviewError("unsafe archive path")
            if not member.isdir() and not member.isfile():
                raise PreviewError("archive links and special files are forbidden")
            filtered = tarfile.data_filter(member, str(destination))
            if filtered is None:
                raise PreviewError("archive member rejected by data filter")
            target = destination.joinpath(*name.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            if str(name) in seen or target.exists():
                raise PreviewError("duplicate archive path")
            seen.add(str(name))
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            incoming = archive.extractfile(filtered)
            if incoming is None:
                raise PreviewError("missing archive member data")
            with incoming, target.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
    # Consume trailing bytes too: reject oversized/truncated transport, not just
    # the prefix tarfile happened to need. No gzip or concatenated tar handling.
    while reader.read(1024 * 1024):
        pass
    for required in ("backend/go.mod", "backend/go.sum", "frontend/package.json", "frontend/package-lock.json"):
        if not (destination / required).is_file():
            raise PreviewError("source archive is missing required application files")


class Controller:
    def __init__(self, config_path: Path):
        config = json.loads(config_path.read_text())
        expected = {"version", "state_dir", "docker_binary", "docker_host", "deployment_mode"}
        if set(config) != expected or config["version"] != 1:
            raise PreviewError("invalid preview config schema")
        self.state = Path(config["state_dir"])
        self.docker_binary = Path(config["docker_binary"])
        self.host = config["docker_host"]
        self.mode = config["deployment_mode"]
        if (not self.state.is_absolute() or self.state.is_symlink()
                or self.state in (Path("/"), Path.home(), TRUSTED_DIR)
                or not self.docker_binary.is_absolute()
                or not self.host.startswith("unix:///")
                or self.mode not in ("rootless", "local-docker-desktop")):
            raise PreviewError("unsafe preview configuration")
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = self.state.stat()
        if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
            raise PreviewError("state directory must be owned by this user and mode 0700")
        self.docker = [str(self.docker_binary), "--host", self.host]
        # Do not inherit CI/SSH credentials or arbitrary DOCKER_/COMPOSE_ controls.
        self.environment = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(Path.home()),
            "DOCKER_CONFIG": str(self.state / "docker-config"),
            "LANG": "C.UTF-8",
        }
        (self.state / "docker-config").mkdir(mode=0o700, exist_ok=True)
        if self.mode == "local-docker-desktop":
            # Docker Desktop's CLI plugins may live alongside its binary or in
            # ~/.docker/cli-plugins. Reuse executables, never credential config.
            binary = self.docker_binary.resolve()
            plugins = [binary.parent.parent / "cli-plugins",
                       binary.parent / "cli-plugins", Path.home() / ".docker/cli-plugins"]
            private_json(self.state / "docker-config/config.json",
                         {"cliPluginsExtraDirs": [str(path) for path in plugins if path.is_dir()]})
        self.environment["BUILDX_CONFIG"] = str(self.state / "buildx")

    def run(self, arguments, *, capture=False, timeout=1800, environment=None):
        try:
            result = subprocess.run(arguments, env=environment or self.environment,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if capture else sys.stderr,
                                    stderr=subprocess.PIPE if capture else sys.stderr,
                                    timeout=timeout, check=False, text=True)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PreviewError(f"command failed: {arguments[0]}") from error
        if result.returncode:
            # Never echo Compose env or arbitrary application logs on failure.
            raise PreviewError(f"command exited {result.returncode}: {arguments[0]}")
        return result.stdout if capture else ""

    def validate_daemon(self):
        info = json.loads(self.run(self.docker + ["info", "--format", "{{json .}}"], capture=True, timeout=30))
        rootless = any("rootless" in option for option in info.get("SecurityOptions", []))
        if self.mode == "rootless":
            if not rootless or info.get("OSType") != "linux" or info.get("Architecture") not in ("x86_64", "amd64"):
                raise PreviewError("dedicated Linux amd64 rootless Docker daemon is required")
            if info.get("CgroupVersion") != "2" or info.get("CgroupDriver") != "systemd":
                raise PreviewError("rootless Docker requires cgroup v2 with systemd delegation")
            delegated = Path(f"/sys/fs/cgroup/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/cgroup.controllers")
            if not {"cpu", "memory", "pids"} <= set(delegated.read_text().split()):
                raise PreviewError("service user's cgroup must delegate cpu, memory and pids")
            socket = Path(self.host.removeprefix("unix://"))
            if socket != Path(f"/run/user/{os.getuid()}/docker.sock"):
                raise PreviewError("rootless Docker must use this user's /run/user/UID/docker.sock")
        elif "docker desktop" not in info.get("OperatingSystem", "").lower():
            raise PreviewError("local development mode is limited to Docker Desktop")
        if not all(info.get(field) is True for field in ("MemoryLimit", "CpuCfsPeriod", "CpuCfsQuota", "PidsLimit")):
            raise PreviewError("Docker must enforce memory, CPU and pids resource limits")
        self.run(self.docker + ["compose", "version"], capture=True, timeout=30)

    @contextlib.contextmanager
    def lock(self, pr):
        with (self.state / "host.lock").open("a") as global_lock:
            fcntl.flock(global_lock, fcntl.LOCK_EX)
            with (self.state / f"pr-{pr}.lock").open("a") as pr_lock:
                fcntl.flock(pr_lock, fcntl.LOCK_EX)
                yield

    def directory(self, pr):
        return self.state / f"pr-{pr}"

    def record(self, pr):
        path = self.directory(pr) / "state.json"
        return json.loads(path.read_text()) if path.exists() else None

    @staticmethod
    def public(pr, record=None, status=None):
        return {"pr": pr, "sha": record.get("sha") if record else None,
                "url": f"http://pr-{pr}.localhost:{20000 + pr}", "port": 20000 + pr,
                "status": status or (record.get("status", "absent") if record else "absent")}

    def compose(self, pr, *arguments, capture=False):
        record = self.record(pr)
        if not record or not record.get("sha"):
            raise PreviewError("preview has no scoped Compose project")
        sha = sha_value(record["sha"])
        return self.run(self.docker + ["compose", "--project-name", f"archive-preview-pr-{pr}-{sha}",
                         "--env-file", str(self.directory(pr) / "runtime.env"),
                         "--file", str(TRUSTED_DIR / "compose.yaml"), *arguments], capture=capture)

    def remove(self, pr):
        directory = self.directory(pr)
        if not directory.exists():
            return
        record = self.record(pr)
        if record:
            record["status"] = "removing"
            private_json(directory / "state.json", record)
        if (directory / "runtime.env").exists():
            self.compose(pr, "down", "--volumes", "--remove-orphans", "--timeout", "15")
        # Local tags are unique to this PR and exact SHA. Never remove shared base
        # images or run global image/builder/volume/network prune.
        if record and record.get("sha"):
            sha = sha_value(record["sha"])
            for tag in (f"archive-preview-api:pr-{pr}-{sha}", f"archive-preview-frontend:pr-{pr}-{sha}"):
                existing = self.run(self.docker + ["image", "ls", "--quiet", "--filter", f"reference={tag}"],
                                    capture=True)
                if existing.strip():
                    self.run(self.docker + ["image", "rm", tag], capture=True)
        shutil.rmtree(directory)

    def status(self, pr):
        record = self.record(pr)
        if record and record.get("status") == "ready":
            try:
                self.http(pr, "/health/ready")
                self.http(pr, "/login")
            except (PreviewError, OSError, urllib.error.URLError):
                return self.public(pr, record, "unhealthy")
        return self.public(pr, record)

    def http(self, pr, path, *, body=None, content_type=None, cookie=None):
        headers = {"Host": f"pr-{pr}.localhost:{20000 + pr}",
                   "Origin": f"http://pr-{pr}.localhost:{20000 + pr}"}
        if content_type:
            headers["Content-Type"] = content_type
        if cookie:
            headers["Cookie"] = cookie
        request = urllib.request.Request(f"http://127.0.0.1:{20000 + pr}{path}", body, headers)
        # Ignore host proxy environment, including HTTP_PROXY on a CI workstation.
        class NoRedirects(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, request, fp, code, message, headers, new_url):
                fp.close()
                raise PreviewError("preview HTTP redirects are forbidden")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects())
        # Socket timeouts alone permit indefinitely slow trickle responses.
        # This wall-clock deadline also covers headers and the full body read.
        signal.alarm(10)
        try:
            with opener.open(request, timeout=5) as response:
                data = response.read(4 * 1024 * 1024 + 1)
                if len(data) > 4 * 1024 * 1024:
                    raise PreviewError("preview API response exceeds limit")
                return data, response.headers
        except urllib.error.HTTPError as error:
            error.close()
            raise PreviewError("preview HTTP request failed") from None
        except (OSError, ValueError, http.client.HTTPException):
            # Status reason phrases/URLs are controlled by branch code. Never
            # echo them: the runtime knows its disposable password.
            raise PreviewError("preview HTTP request failed") from None
        finally:
            signal.alarm(0)

    def ready(self, pr):
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            try:
                self.http(pr, "/health/ready")
                self.http(pr, "/login")
                return
            except (OSError, urllib.error.URLError, PreviewError):
                time.sleep(2)
        raise PreviewError("preview did not become HTTP ready")

    def seed(self, pr, password):
        login, headers = self.http(
            pr, "/api/auth/login",
            body=json.dumps({"username": "preview", "password": password}).encode(),
            content_type="application/json")
        if json.loads(login).get("user", {}).get("username") != "preview":
            raise PreviewError("real login proof failed")
        cookies = headers.get_all("Set-Cookie") or []
        cookie = next((value.split(";", 1)[0] for value in cookies
                       if value.startswith("archive_session=")), None)
        if not cookie:
            raise PreviewError("real login did not issue a session cookie")
        marker = f"previewproof{pr}"
        payload = f"Synthetic Archive preview PR {pr}. No production data.\n"
        zipped = io.BytesIO()
        with zipfile.ZipFile(zipped, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(f"docs/{marker}.txt", payload)
            archive.writestr("Cookies/Chrome_0.txt",
                             ".example.test\tTRUE\t/\tFALSE\t1893456000\tarchive_preview\tfake-cookie-value\n")
            archive.writestr("Browser/passwords.txt",
                             "https://example.test/login\tpreview@example.test\tFakePreviewPassword123!\n")
        boundary = "archive-preview-" + secrets.token_hex(16)
        multipart = (f"--{boundary}\r\n"
                     'Content-Disposition: form-data; name="file"; filename="preview-seed.zip"\r\n'
                     "Content-Type: application/zip\r\n\r\n").encode()
        multipart += zipped.getvalue() + f"\r\n--{boundary}--\r\n".encode()
        uploaded, _ = self.http(pr, "/api/archives", body=multipart,
                                content_type=f"multipart/form-data; boundary={boundary}", cookie=cookie)
        item = json.loads(uploaded).get("archive", {})
        if item.get("status") != "indexed" or not item.get("id"):
            raise PreviewError("real upload did not index the synthetic archive")
        query = urllib.parse.urlencode({"q": marker, "archive": item["id"], "limit": 10})
        found, _ = self.http(pr, "/api/search?" + query, cookie=cookie)
        results = json.loads(found).get("results", [])
        if not any(result.get("archiveId") == item["id"]
                   and result.get("path") == f"docs/{marker}.txt" for result in results):
            raise PreviewError("real seed search proof failed")
        query = urllib.parse.urlencode({"path": f"docs/{marker}.txt"})
        viewed, _ = self.http(pr, f"/api/archives/{item['id']}/file?" + query, cookie=cookie)
        if json.loads(viewed).get("text") != payload:
            raise PreviewError("real seed content proof failed")
        cookies, _ = self.http(pr, "/api/cookies?domain=example.test", cookie=cookie)
        if not any(row.get("archiveId") == item["id"] and "fake-cookie-value" in row.get("netscapeText", "")
                   for row in json.loads(cookies).get("logs", [])):
            raise PreviewError("real synthetic cookie extraction proof failed")
        passwords, _ = self.http(pr, "/api/passwords?q=example.test", cookie=cookie)
        if not any(row.get("archiveId") == item["id"] and row.get("password") == "FakePreviewPassword123!"
                   for row in json.loads(passwords).get("results", [])):
            raise PreviewError("real synthetic password extraction proof failed")

    def deploy(self, pr, sha, stream):
        self.remove(pr)
        directory = self.directory(pr)
        directory.mkdir(mode=0o700)
        source = directory / "source"
        source.mkdir(mode=0o700)
        password, db_password = secrets.token_urlsafe(32), secrets.token_hex(32)
        record = {"sha": sha, "status": "deploying", "username": "preview", "password": password}
        private_json(directory / "state.json", record)
        api_image = f"archive-preview-api:pr-{pr}-{sha}"
        frontend_image = f"archive-preview-frontend:pr-{pr}-{sha}"
        env = {"API_IMAGE": api_image, "FRONTEND_IMAGE": frontend_image,
               "PUBLIC_ORIGIN": f"http://pr-{pr}.localhost:{20000 + pr}",
               "PREVIEW_PORT": str(20000 + pr), "ROOT_PASSWORD": password,
               "DB_PASSWORD": db_password, "TRUSTED_DIR": str(TRUSTED_DIR)}
        fd = os.open(directory / "runtime.env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write("".join(f"{key}={value}\n" for key, value in env.items()))
        try:
            signal.alarm(300)
            try:
                extract_source(stream, source)
            finally:
                signal.alarm(0)
            for component, tag in (("api", api_image), ("frontend", frontend_image)):
                context = source / ("backend" if component == "api" else "frontend")
                self.run(self.docker + ["build", "--platform", "linux/amd64", "--tag", tag,
                         "--file", str(TRUSTED_DIR / f"Dockerfile.{component}"), str(context)])
            self.compose(pr, "up", "--detach", "--wait", "--wait-timeout", "240")
            self.ready(pr)
            self.seed(pr, password)
            record["status"] = "ready"
            private_json(directory / "state.json", record)
            return self.public(pr, record)
        except BaseException:
            # Persist no success and expose no half-created gateway after failure.
            try:
                self.remove(pr)
            except Exception as cleanup_error:
                print(f"scoped cleanup failed: {cleanup_error}", file=sys.stderr)
            if directory.exists():
                private_json(directory / "state.json", {"sha": sha, "status": "failed"})
            raise


def parser():
    result = argparse.ArgumentParser(description=HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    result.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    result.add_argument("--role", choices=("admin", "deploy", "review"), default="admin")
    result.add_argument("--ssh", action="store_true", help="parse only SSH_ORIGINAL_COMMAND for a restricted forced command")
    result.add_argument("action", nargs="?", choices=("deploy", "destroy", "status", "credentials"))
    result.add_argument("pr", nargs="?", type=pr_number)
    result.add_argument("sha", nargs="?", type=sha_value)
    return result


def main():
    if sys.version_info < (3, 12):
        raise PreviewError("Python 3.12 or newer is required")
    os.umask(0o077)
    def interrupted(signum, frame):
        if signum == signal.SIGALRM:
            raise PreviewError("preview operation exceeded its absolute deadline")
        raise PreviewInterrupted(f"controller interrupted by signal {signum}")
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGALRM):
        signal.signal(signum, interrupted)
    arguments = parser().parse_args()
    if arguments.ssh:
        if arguments.action is not None or arguments.role == "admin":
            raise PreviewError("invalid forced-command invocation")
        tokens = shlex.split(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
        if (not tokens or tokens[0] not in {"deploy", "destroy", "status", "credentials"}
                or len(tokens) != (3 if tokens[0] == "deploy" else 2)):
            raise PreviewError("SSH role has no shell; use an exact allowed command or ssh -N")
        try:
            arguments.action = tokens[0]
            arguments.pr = pr_number(tokens[1])
            arguments.sha = sha_value(tokens[2]) if tokens[0] == "deploy" else None
        except argparse.ArgumentTypeError as error:
            raise PreviewError(str(error)) from error
    if arguments.action is None or arguments.pr is None:
        raise PreviewError("an action and PR number are required")
    if (arguments.action == "deploy") != (arguments.sha is not None):
        raise PreviewError("only deploy requires a SHA argument")
    allowed = {"admin": {"deploy", "destroy", "status", "credentials"},
               "deploy": {"deploy", "destroy", "status"}, "review": {"credentials", "status"}}
    if arguments.action not in allowed[arguments.role]:
        raise PreviewError("command is not permitted for this SSH role")
    controller = Controller(arguments.config)
    with controller.lock(arguments.pr):
        controller.validate_daemon()
        if arguments.action == "deploy":
            result = controller.deploy(arguments.pr, arguments.sha, sys.stdin.buffer)
        elif arguments.action == "destroy":
            controller.remove(arguments.pr)
            result = controller.public(arguments.pr, status="removed")
        elif arguments.action == "credentials":
            record = controller.record(arguments.pr)
            if not record or record.get("status") != "ready":
                raise PreviewError("preview has no ready credentials")
            result = {**controller.public(arguments.pr, record), "username": record["username"], "password": record["password"]}
        else:
            result = controller.status(arguments.pr)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (PreviewError, PreviewInterrupted, OSError, ValueError, tarfile.TarError) as error:
        print(f"archive-preview: {error}", file=sys.stderr)
        sys.exit(1)
