"""Install the already benchmarked CPU runner as a limited local user service on nl-server.

Requires loginctl enable-linger for this user to keep the service running after logout/reboot.
Does not install packages, fetch models, access credentials or enable order execution.
"""
import hashlib
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request


def main():
    if subprocess.run(["systemctl", "--user", "is-active", "--quiet", "opentrader-lfm-link"], check=False).returncode == 0:
        raise RuntimeError("Inference is hosted on proud-server; do not reinstall a competing local model")
    source = Path.home() / "ai-benchmark-20261107"
    manifest = source / "models" / "LFM2.5-1.2B-Instruct-Q4_K_M.gguf"
    expected = "b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5"
    if hashlib.file_digest(manifest.open("rb"), "sha256").hexdigest() != expected:
        raise ValueError("Model checksum mismatch")
    target = Path.home() / ".local" / "share" / "opentrader-ai"
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    subprocess.run(["systemctl", "--user", "stop", "opentrader-lfm.service"], check=False, capture_output=True)
    shutil.copy2(source / "build" / "bin" / "llama-server", target / "llama-server")
    shutil.copy2(manifest, target / "model.gguf")
    unit_directory = Path.home() / ".config" / "systemd" / "user"
    unit_directory.mkdir(parents=True, exist_ok=True)
    (unit_directory / "opentrader-lfm.service").write_text(f"""[Unit]
Description=OpenTrader local explanations (LFM2.5; no trading tools)
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
ExecStart=/usr/bin/taskset -c 2,3 {target}/llama-server --model {target}/model.gguf --host 127.0.0.1 --port 18089 --threads 2 --threads-batch 2 --ctx-size 2048 --parallel 1 --n-gpu-layers 0 --jinja --reasoning off
CPUQuota=200%
CPUWeight=10
Nice=15
IOWeight=10
MemoryMax=3G
MemorySwapMax=0
TasksMax=64
NoNewPrivileges=true
Restart=on-failure
RestartSec=30
TimeoutStopSec=15

[Install]
WantedBy=default.target
""")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "opentrader-lfm.service"], check=True)
    for _ in range(60):
        try:
            with urllib.request.urlopen("http://127.0.0.1:18089/health", timeout=2) as response:
                if response.status == 200:
                    print("Local model ready on loopback; two CPU threads, low priority, 3 GiB memory ceiling.")
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError("Local model did not become healthy; dashboard is unaffected")


if __name__ == "__main__":
    main()
