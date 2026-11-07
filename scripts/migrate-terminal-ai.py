"""Move only LFM inference from nl-server to proud-server after a passing coexistence test.

Run prepare-link on nl-server, install-proud as root on proud-server, then switch-link
and (only after dashboard verification) cleanup-nl on nl-server. Private keys never leave nl-server.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import time
import urllib.request

HOST = "159.195.248.197"
USER = "opentrader-ai"
MODEL_SHA = "b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5"
RUNNER_SHA = "368227edcc229be5f9bed16a2223d79b5e41d0ac2e19bcf5825e82291c060e55"


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def public_key(path):
    fields = path.read_text().strip().split()
    if len(fields) < 2 or fields[0] != "ssh-ed25519" or not re.fullmatch(r"[A-Za-z0-9+/=]+", fields[1]):
        raise ValueError("Expected an Ed25519 public key")
    return " ".join(fields[:2])


def verify(path, expected):
    with path.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != expected:
            raise ValueError("Checksum mismatch: " + str(path))


def health(port):
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError("Inference health check failed")


def prepare_link(host_key):
    directory = Path.home() / ".config/opentrader-ai-link"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    key = directory / "id_ed25519"
    if not key.exists():
        run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "opentrader-inference-only", "-f", str(key))
    key.chmod(0o600)
    known_hosts = directory / "known_hosts"
    known_hosts.write_text(HOST + " " + public_key(host_key) + "\n")
    known_hosts.chmod(0o600)
    unit = Path.home() / ".config/systemd/user/opentrader-lfm-link.service"
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text(f"""[Unit]
Description=Private authenticated link to proud-server LFM

[Service]
ExecStart=/usr/bin/ssh -NT -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile={known_hosts} -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -i {key} -L 127.0.0.1:18089:127.0.0.1:18090 {USER}@{HOST}
Restart=always
RestartSec=5
MemoryMax=64M
CPUQuota=10%
NoNewPrivileges=true

[Install]
WantedBy=default.target
""")
    run("systemctl", "--user", "daemon-reload")
    print(public_key(directory / "id_ed25519.pub"))


def install_proud(client_key):
    if os.geteuid() != 0:
        raise PermissionError("Proud provisioning requires root")
    benchmark = Path("/root/proud-lfm-benchmark-20261107")
    summary = json.loads((benchmark / "summary.json").read_text())
    if summary.get("passed") is not True:
        raise RuntimeError("Coexistence benchmark must pass before migration")
    verify(benchmark / "lfm.gguf", MODEL_SHA)
    previous = Path("/root/proud-ai-benchmark-20261107")
    verify(previous / "runner.tar.gz", RUNNER_SHA)
    # Copy the exact directory used by the passing test, including its shared libraries.
    destination = Path("/opt/opentrader-lfm")
    if destination.exists():
        raise RuntimeError("An installation already exists; review before replacing it")
    public_key(client_key)
    try:
        account = pwd.getpwnam(USER)
        if account.pw_dir != "/var/lib/opentrader-ai" or account.pw_uid >= 1000:
            raise RuntimeError("Unexpected existing service account")
    except KeyError:
        pass
    config = Path("/etc/ssh/sshd_config.d/70-opentrader-ai.conf")
    authorized = Path("/etc/ssh/authorized_keys") / USER
    unit = Path("/etc/systemd/system/opentrader-lfm.service")
    if any(path.exists() for path in [config, authorized, unit]):
        raise RuntimeError("Inference or SSH configuration already exists; review before replacing it")
    try:
        install_proud_files(previous, destination, benchmark, client_key)
    except Exception:
        subprocess.run(["systemctl", "disable", "--now", "opentrader-lfm"], capture_output=True)
        for path in [unit, config, authorized]:
            path.unlink(missing_ok=True)
        subprocess.run(["systemctl", "daemon-reload"], capture_output=True)
        subprocess.run(["systemctl", "reload", "ssh"], capture_output=True)
        # This directory did not exist before this attempt. Never follow a replacement symlink.
        if destination.is_dir() and not destination.is_symlink():
            shutil.rmtree(destination)
        raise


def install_proud_files(previous, destination, benchmark, client_key):
    destination.mkdir(mode=0o755)
    shutil.copytree(previous / "runner/llama-b12110", destination / "runner")
    shutil.copy2(benchmark / "lfm.gguf", destination / "model.gguf")
    (destination / "model.gguf").chmod(0o644)
    try:
        account = pwd.getpwnam(USER)
        if account.pw_dir != "/var/lib/opentrader-ai" or account.pw_uid >= 1000:
            raise RuntimeError("Unexpected existing service account")
    except KeyError:
        run("useradd", "--system", "--user-group", "--create-home", "--home-dir", "/var/lib/opentrader-ai",
            "--shell", "/usr/sbin/nologin", USER)
    key_directory = Path("/etc/ssh/authorized_keys")
    key_directory.mkdir(mode=0o755, exist_ok=True)
    authorized = key_directory / USER
    authorized.write_text('restrict,port-forwarding,permitopen="127.0.0.1:18090" ' + public_key(client_key) + "\n")
    authorized.chmod(0o644)
    ssh_config = Path("/etc/ssh/sshd_config.d/70-opentrader-ai.conf")
    if ssh_config.exists():
        raise RuntimeError("Dedicated SSH policy already exists; review it")
    ssh_config.write_text(f"""Match User {USER}
    AuthorizedKeysFile /etc/ssh/authorized_keys/{USER}
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding local
    AllowStreamLocalForwarding no
    PermitOpen 127.0.0.1:18090
    PermitListen none
    PermitTTY no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    MaxSessions 0
Match all
""")
    try:
        run("/usr/sbin/sshd", "-t")
    except Exception:
        ssh_config.unlink()
        raise
    run("systemctl", "reload", "ssh")
    Path("/etc/systemd/system/opentrader-lfm.service").write_text("""[Unit]
Description=Private LFM explanations for OpenTrader
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
User=opentrader-ai
Group=opentrader-ai
WorkingDirectory=/var/lib/opentrader-ai
ExecStart=/usr/bin/taskset -c 2,3 /opt/opentrader-lfm/runner/llama-server --model /opt/opentrader-lfm/model.gguf --host 127.0.0.1 --port 18090 --threads 2 --threads-batch 2 --ctx-size 2048 --parallel 1 --n-gpu-layers 0 --jinja --reasoning off
CPUQuota=200%
CPUWeight=10
Nice=15
IOWeight=10
MemoryMax=1536M
MemorySwapMax=0
TasksMax=64
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/opentrader-ai
CapabilityBoundingSet=
Restart=on-failure
RestartSec=30
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
""")
    run("systemctl", "daemon-reload")
    run("systemctl", "enable", "--now", "opentrader-lfm")
    health(18090)
    print("Proud LFM ready; loopback only, restricted forwarding account, no remote shell.")


def switch_link():
    run("systemctl", "--user", "stop", "opentrader-lfm")
    try:
        run("systemctl", "--user", "enable", "--now", "opentrader-lfm-link")
        health(18089)
        (Path.home() / ".config/opentrader-ai-link/cutover.json").write_text(json.dumps({"at": time.time()*1000}))
        run("docker", "restart", "opentrader-terminal-assistant")
    except Exception:
        subprocess.run(["systemctl", "--user", "disable", "--now", "opentrader-lfm-link"], capture_output=True)
        run("systemctl", "--user", "start", "opentrader-lfm")
        raise
    print("Inference now forwarded to proud-server; local model files retained until dashboard verification.")


def cleanup_nl():
    run("systemctl", "--user", "is-active", "opentrader-lfm-link")
    health(18089)
    # Require a verified fresh result after cutover, not just the tunnel's TCP listener.
    snapshot = json.loads(run("docker", "exec", "opentrader-terminal-assistant", "node", "--input-type=module", "-e",
       "import{readFile}from'node:fs/promises';console.log(await readFile('/assistant/commentary.json','utf8'))"))
    cutover = json.loads((Path.home() / ".config/opentrader-ai-link/cutover.json").read_text())["at"]
    if snapshot.get("status") != "ready" or snapshot.get("generatedAt", 0) < cutover or time.time()*1000 - snapshot.get("generatedAt", 0) > 180000:
        raise RuntimeError("A fresh completed dashboard explanation is required before removing local LFM")
    targets = [Path.home() / ".local/share/opentrader-ai/model.gguf",
      Path.home() / ".local/share/opentrader-ai/llama-server",
      Path.home() / "ai-benchmark-20261107/models/LFM2.5-1.2B-Instruct-Q4_K_M.gguf"]
    for target in targets:
        if target.is_symlink() or not target.resolve().is_relative_to(Path.home().resolve()):
            raise ValueError("Unexpected cleanup path")
    unit = Path.home() / ".config/systemd/user/opentrader-lfm.service"
    if unit.is_symlink() or not unit.resolve().is_relative_to(Path.home().resolve()):
        raise ValueError("Unexpected service file")
    run("systemctl", "--user", "disable", "--now", "opentrader-lfm")
    unit.unlink()
    run("systemctl", "--user", "daemon-reload")
    for target in targets:
        target.unlink(missing_ok=True)
    directory = Path.home() / ".local/share/opentrader-ai"
    if directory.exists() and not any(directory.iterdir()): directory.rmdir()
    print("Removed nl-server LFM service, production runner/weights and benchmark LFM weight copy. Dashboard and commentary worker retained.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare-link", "install-proud", "switch-link", "cleanup-nl"])
    parser.add_argument("--host-key", type=Path)
    parser.add_argument("--public-key", type=Path)
    args = parser.parse_args()
    if args.action == "prepare-link": prepare_link(args.host_key)
    elif args.action == "install-proud": install_proud(args.public_key)
    elif args.action == "switch-link": switch_link()
    else: cleanup_nl()
