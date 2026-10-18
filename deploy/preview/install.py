#!/usr/bin/env python3
"""Install reviewed preview infrastructure on a dedicated rootless Docker host."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys

ASSETS = ("controller.py", "compose.yaml", "Dockerfile.api", "Dockerfile.frontend", "Caddyfile")
INSTALL = Path("/opt/archive-preview")
CONFIG = Path("/etc/archive-preview")
HELP = """Install trusted Archive preview infrastructure (Python 3.12+ stdlib).

Run only on a NEW, dedicated, disposable Linux amd64 preview VPS. The hostname
must contain 'preview', and --dedicated-host must match its exact hostname.
Known production host/address, existing Archive production paths/containers,
rootful Docker, remote Docker endpoints, sudo/docker-group users and unsafe paths
are refused. There is deliberately no production/rootful bypass.

Administrator prerequisites (installed manually, never fetched by this tool):
  1. Install Python 3.12+, Docker Engine + Compose v2 and rootless prerequisites
     (uidmap/rootlesskit; /etc/subuid and /etc/subgid allocation).
  2. Create a dedicated login user named archive-preview, no sudo/docker group:
       useradd --create-home --shell /bin/sh archive-preview
       loginctl enable-linger archive-preview
  3. As that user, install/start rootless Docker using the distribution's Docker
     rootless setup tool. Its socket MUST be /run/user/UID/docker.sock. Set up the
     user's systemd Docker service to survive logout/reboot. Do not grant rootful
     Docker socket access. Install Compose as a system-wide Docker CLI plugin.
     Resource limits require cgroup v2 + systemd delegation of memory/cpu/pids;
     Docker info must report those limits as supported. A rootless daemon with
     silently ignored cgroup limits is refused.
     If needed, set [Service] Delegate=cpu cpuset io memory pids in
     /etc/systemd/system/user@.service.d/delegate.conf, run systemctl daemon-reload,
     then restart the user's service/session and Docker. See Docker rootless tips:
     https://docs.docker.com/engine/security/rootless/tips/#limiting-resources
     The SSH daemon must globally use PermitUserEnvironment no (the default).
  4. Copy REVIEWED deploy/preview assets, one deployment public key and at least
     one DIFFERENT reviewer public key onto this new host. Keep private keys
     elsewhere. Do not copy production .env/data.

Install (root, from the reviewed source directory):
  python3.12 deploy/preview/install.py --user archive-preview \\
    --dedicated-host archive-preview-1 \\
    --deploy-key-file /root/preview-deploy.pub \\
    --review-key-file /root/preview-review.pub
Repeat --review-key-file /root/collaborator.pub for each additional reviewer.
Duplicate reviewer keys are installed once; the deployment key is never accepted
as a reviewer key. Reinstallation replaces the managed key list with this set.

The installer writes root-owned /opt/archive-preview, /etc/archive-preview/config.json,
/etc/archive-preview/authorized_keys and /etc/ssh/sshd_config.d/80-archive-preview.conf.
It prints the authorized_keys restrictions and operator commands. It DOES NOT
reload sshd, alter a firewall, obtain host keys, create users, install Docker, or
contact production/GitHub. Before reload, ensure sshd_config includes its .d/*.conf
files; validate with sshd -t and review sshd -T -C user=archive-preview,host=localhost,addr=127.0.0.1.
Only then reload sshd, keeping your independent administrator connection open.

Deploy identity: deploy/destroy/status only; no shell, PTY, agent, X11 or forwards.
Review identity: credentials/status only, no shell/PTY/agent/X11; local TCP forwards
ONLY to 127.0.0.1 ports (sshd PermitListen none forbids remote forwards). SSH -N
works: no session is requested, so forced-command is not invoked.

Get the host's public key via trusted console/admin channel, e.g.
  cat /etc/ssh/ssh_host_ed25519_key.pub
Pin its verified value in GitHub ARCHIVE_PREVIEW_KNOWN_HOSTS (including hostname,
and [hostname]:port for nonstandard ports); NEVER discover trust with ssh-keyscan.
Set ARCHIVE_PREVIEW_SSH_TARGET=archive-preview@HOST and optional
ARCHIVE_PREVIEW_SSH_PORT (default 22), put only
the deploy private key into ARCHIVE_PREVIEW_SSH_KEY, then set
ARCHIVE_PREVIEW_ENABLED=true. Keep review private keys with authorized reviewers.

Reviewer commands (use -i /path/to/review-key and pinned known_hosts as appropriate):
  ssh archive-preview@HOST 'status 123'
  ssh archive-preview@HOST 'credentials 123'
  ssh -N -L 127.0.0.1:20123:127.0.0.1:20123 archive-preview@HOST
  # Open http://pr-123.localhost:20123; use returned disposable credentials.
Deploy command: git archive EXACT_SHA | ssh DEPLOY_TARGET 'deploy 123 EXACT_SHA'
Cleanup: ssh DEPLOY_TARGET 'destroy 123'. Pushes reset synthetic data/credentials.
The deploy key must NOT be used to retrieve credentials or open a tunnel.

No public ingress beyond SSH is needed. DNS is not needed for *.localhost. State
is mode0700 at /home/archive-preview/.local/share/archive-preview; credentials/env
files mode0600. Runtime is internal-networked with bounded tmpfs data, CPU/memory,
pids/logs and read-only roots. Dependencies/fonts require build egress; the dedicated
rootless host is a boundary, not a guarantee against malicious branch code. Monitor
host disk (source/image/build cache), RAM and active previews; never colocate
production workloads/secrets. Destroy is scoped; it never globally prunes caches.
"""


def fail(message):
    raise RuntimeError(message)


def run(arguments, *, user=None, capture=True):
    if user:
        arguments = ["runuser", "--user", user.pw_name, "--", "env", "-i",
                     f"HOME={user.pw_dir}", "PATH=/usr/local/bin:/usr/bin:/bin",
                     f"XDG_RUNTIME_DIR=/run/user/{user.pw_uid}", *arguments]
    result = subprocess.run(arguments, stdin=subprocess.DEVNULL, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None, timeout=60)
    if result.returncode:
        fail(f"prerequisite command failed: {arguments[0]} (exit {result.returncode})")
    return result.stdout


def public_key(path):
    value = path.read_text().strip()
    if "\n" in value or "\r" in value:
        fail("each public key file must contain one key")
    fields = value.split()
    if len(fields) < 2 or fields[0] not in ("ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"):
        fail("public key must be a bare OpenSSH public key without options")
    if not re.fullmatch(r"[A-Za-z0-9+/]+={0,3}", fields[1]):
        fail("invalid SSH public key encoding")
    return " ".join(fields[:2])


def protected_path(path):
    for parent in (path, *path.parents):
        if parent.is_symlink():
            fail(f"symlink in trusted installation path: {parent}")
        if parent.exists():
            mode = parent.stat()
            if mode.st_uid != 0 or stat.S_IMODE(mode.st_mode) & 0o022:
                fail(f"trusted installation path is not root-owned/private: {parent}")


def main():
    parser = argparse.ArgumentParser(description=HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--user", required=True, choices=["archive-preview"])
    parser.add_argument("--dedicated-host", required=True, help="exact hostname of the new dedicated preview host")
    parser.add_argument("--deploy-key-file", type=Path, required=True)
    parser.add_argument("--review-key-file", type=Path, action="append", required=True,
                        help="reviewer public key; repeat for additional reviewers")
    parser.add_argument("--forbidden-production-ip", default="",
                        help="operator-supplied production address to refuse on this host; "
                             "keep real production addresses out of this public repository")
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        fail("Python 3.12+ is required")
    if os.geteuid() != 0 or platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
        fail("installer requires root on dedicated Linux amd64; local smoke uses controller config instead")
    host = socket.gethostname()
    if args.dedicated_host != host or "preview" not in host.lower() or re.search(r"prod|transfer|vault", host, re.I):
        fail("dedicated hostname must match and contain preview, without production-like names")
    ip = shutil.which("ip")
    if not ip:
        fail("iproute2 is required to validate local host addresses")
    addresses = set()
    for interface in json.loads(run([ip, "-json", "address", "show"])):
        addresses.update(item.get("local", "") for item in interface.get("addr_info", []))
    if args.forbidden_production_ip and args.forbidden_production_ip in addresses:
        fail("operator-marked production address refused")
    production_paths = [Path("/srv/archive"), Path("/opt/archive"), Path("/root/archive"),
                        *Path("/home").glob("*/archive")]
    if any(path.exists() for path in production_paths):
        fail("existing production-like Archive path refused")
    user = pwd.getpwnam(args.user)
    if user.pw_uid == 0 or Path(user.pw_dir) != Path("/home/archive-preview"):
        fail("service account must be non-root with /home/archive-preview home")
    home = Path(user.pw_dir)
    if home.is_symlink() or home.stat().st_uid != user.pw_uid or stat.S_IMODE(home.stat().st_mode) & 0o022:
        fail("service home must be owned by the service user and not group/world writable")
    forbidden_groups = {"sudo", "wheel", "docker", "root"}
    import grp
    memberships = {grp.getgrgid(group).gr_name for group in os.getgrouplist(user.pw_name, user.pw_gid)}
    if memberships & forbidden_groups:
        fail("preview user must not belong to sudo/wheel/root/docker groups")
    group_ids = os.getgrouplist(user.pw_name, user.pw_gid)
    rootful = Path("/var/run/docker.sock")
    if rootful.exists():
        metadata = rootful.stat()
        if (metadata.st_uid == user.pw_uid or metadata.st_mode & stat.S_IWOTH
                or (metadata.st_gid in group_ids and metadata.st_mode & stat.S_IWGRP)):
            fail("preview user must not have access to a rootful Docker socket")
    # A root-owned, executable interpreter must also be reachable by the service
    # user; root's private pyenv/uv interpreter cannot serve forced SSH commands.
    interpreter = Path(sys.executable).resolve()
    protected_path(interpreter)
    run([str(interpreter), "--version"], user=user)
    docker = shutil.which("docker")
    if not docker:
        fail("Docker CLI is missing")
    protected_path(Path(docker).resolve())
    socket_path = Path(f"/run/user/{user.pw_uid}/docker.sock")
    if not socket_path.is_socket() or socket_path.stat().st_uid != user.pw_uid:
        fail("service user's rootless Docker socket is missing")
    daemon = [docker, "--host", f"unix://{socket_path}"]
    info = json.loads(run(daemon + ["info", "--format", "{{json .}}"], user=user))
    if (not any("rootless" in option for option in info.get("SecurityOptions", []))
            or info.get("OSType") != "linux" or info.get("Architecture") not in ("x86_64", "amd64")):
        fail("daemon must be Linux amd64 rootless Docker")
    if (info.get("CgroupVersion") != "2" or info.get("CgroupDriver") != "systemd"
            or not all(info.get(field) is True for field in ("MemoryLimit", "CpuCfsPeriod", "CpuCfsQuota", "PidsLimit"))):
        fail("rootless Docker requires delegated cgroup v2/systemd memory, CPU and pids limits")
    delegated = Path(f"/sys/fs/cgroup/user.slice/user-{user.pw_uid}.slice/user@{user.pw_uid}.service/cgroup.controllers")
    if not {"cpu", "memory", "pids"} <= set(delegated.read_text().split()):
        fail("service user's cgroup must delegate cpu, memory and pids")
    run([docker, "--config", "/etc/archive-preview/isolated-docker-config", "--host",
         f"unix://{socket_path}", "compose", "version"], user=user)
    names = run(daemon + ["ps", "--all", "--format", "{{.Names}}"], user=user).splitlines()
    if any(not name.startswith("archive-preview-pr-") for name in names):
        fail("daemon contains non-preview workloads; a dedicated daemon/host is required")
    sshd = shutil.which("sshd")
    if not sshd:
        fail("OpenSSH sshd is required")
    effective = run([sshd, "-T", "-C", f"user={user.pw_name},host={host},addr=127.0.0.1"])
    if "permituserenvironment no" not in effective.splitlines():
        fail("sshd must globally use PermitUserEnvironment no")
    deploy = public_key(args.deploy_key_file)
    reviews = list(dict.fromkeys(public_key(path) for path in args.review_key_file))
    if deploy in reviews:
        fail("deploy and review identities must use different keys")
    for target in (INSTALL, CONFIG, Path("/etc/ssh/sshd_config.d")):
        protected_path(target)
        target.mkdir(mode=0o755, parents=True, exist_ok=True)
    # Install only the reviewed allowlist, never a branch-controlled executable.
    origin = Path(__file__).resolve().parent
    for name in ASSETS:
        source = origin / name
        if source.is_symlink() or not source.is_file():
            fail(f"missing/nonregular trusted asset: {name}")
        destination = INSTALL / name
        if destination.is_symlink():
            fail("refusing symlink installation destination")
        shutil.copyfile(source, destination)
        destination.chmod(0o755 if name == "controller.py" else 0o644)
        os.chown(destination, 0, 0)
    state = home / ".local/share/archive-preview"
    for path in (home / ".local", home / ".local/share", state):
        if path.is_symlink():
            fail("symlink in private state directory")
        path.mkdir(mode=0o700, exist_ok=True)
        if path.stat().st_uid not in (0, user.pw_uid):
            fail("unexpected private state owner")
        os.chown(path, user.pw_uid, user.pw_gid)
        path.chmod(0o700)
    configuration = {"version": 1, "state_dir": str(state), "docker_binary": docker,
                     "docker_host": f"unix://{socket_path}", "deployment_mode": "rootless"}
    config_path = CONFIG / "config.json"
    if config_path.is_symlink():
        fail("refusing symlink config destination")
    config_path.write_text(json.dumps(configuration, indent=2) + "\n")
    config_path.chmod(0o644)
    os.chown(config_path, 0, 0)
    command = f"{shlex.quote(str(interpreter))} -I {INSTALL}/controller.py --config {config_path} --ssh --role"
    deploy_line = f'restrict,command="{command} deploy" {deploy} archive-preview-deploy'
    review_lines = [
        f'restrict,port-forwarding,permitopen="127.0.0.1:*",'
        f'command="{command} review" {review} archive-preview-review'
        for review in reviews
    ]
    authorized_keys = "\n".join([deploy_line, *review_lines]) + "\n"
    keys = CONFIG / "authorized_keys"
    if keys.is_symlink():
        fail("refusing symlink authorized_keys destination")
    keys.write_text(authorized_keys)
    keys.chmod(0o644)
    os.chown(keys, 0, 0)
    ssh_config = Path("/etc/ssh/sshd_config.d/80-archive-preview.conf")
    if ssh_config.is_symlink():
        fail("refusing symlink sshd config destination")
    ssh_config.write_text(
        "# Trusted preview account: all keys are forced-command restricted.\n"
        "Match User archive-preview\n"
        "    AuthorizedKeysFile /etc/archive-preview/authorized_keys\n"
        "    PasswordAuthentication no\n"
        "    KbdInteractiveAuthentication no\n"
        "    AuthenticationMethods publickey\n"
        "    AllowTcpForwarding local\n"
        "    AllowStreamLocalForwarding no\n"
        "    PermitOpen 127.0.0.1:*\n"
        "    PermitListen none\n"
        "    GatewayPorts no\n"
        "    AllowAgentForwarding no\n"
        "    X11Forwarding no\n"
        "    PermitTTY no\n"
        "    PermitTunnel no\n"
        "    PermitUserRC no\n"
        "Match all\n")
    ssh_config.chmod(0o644)
    os.chown(ssh_config, 0, 0)
    print("Installed trusted runtime at /opt/archive-preview; private state at " + str(state))
    print("Authorized keys (public only):\n" + authorized_keys, end="")
    print("Before SSH use: verify Include sshd_config.d, then sshd -t; inspect effective Match settings;")
    print("reload sshd via your distro service manager, retaining an independent administrator session.")
    print("Pin the console-verified host key; configure GitHub variables/secrets listed in --help.")
    print("Review: ssh archive-preview@HOST 'credentials 123'")
    print("Tunnel: ssh -N -L 127.0.0.1:20123:127.0.0.1:20123 archive-preview@HOST")
    print("Open http://pr-123.localhost:20123. Every deploy resets all synthetic preview data.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(f"archive-preview install: {error}", file=sys.stderr)
        sys.exit(1)
