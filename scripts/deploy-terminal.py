"""Deploy a verified GitHub terminal artifact over the existing OpenTrader image."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tarfile
import time


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("commit")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        raise ValueError("A full GitHub commit SHA is required")
    release = args.archive.resolve().parent / args.commit
    release.mkdir(exist_ok=False)
    with tarfile.open(args.archive) as archive:
        for member in archive.getmembers():
            path = Path(member.name)
            if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
                raise ValueError("Unexpected archive entry")
        archive.extractall(release)
    manifest = (release / "COMMIT").read_text().strip()
    if manifest != args.commit:
        raise ValueError("Artifact commit does not match the requested GitHub commit")
    original = "opentrader-bb-rsi"
    monitor = "opentrader-classic-monitor"
    prior = json.loads(docker("inspect", original))[0]
    networks = list(prior["NetworkSettings"]["Networks"])
    if networks != ["opentrader-private"] or prior["HostConfig"]["PortBindings"]:
        raise ValueError("Deployment topology changed. Review it before updating.")
    image = "opentrader-custom:terminal-" + args.commit[:12]
    base_image = "opentrader-custom:terminal-base-" + args.commit[:12]
    docker("tag", prior["Image"], base_image)
    (release / "Dockerfile").write_text(
        f"FROM {base_image}\nCOPY app/ /app/app/\n"
        "COPY packages/exchanges/classic-monitor.mjs /app/packages/exchanges/classic-monitor.mjs\n"
        "COPY packages/exchanges/classic-agents.mjs /app/packages/exchanges/classic-agents.mjs\n"
        f"LABEL org.opencontainers.image.revision={args.commit}\n"
    )
    docker("build", "--network", "none", "-t", image, str(release))
    volume = "opentrader-terminal-state"
    credentials_volume = "opentrader-terminal-credentials"
    docker("volume", "create", volume)
    docker("volume", "create", credentials_volume)
    # Check public markets without overwriting the running account snapshot.
    snapshot = json.loads(docker("run", "--rm", "--tmpfs", "/terminal",
           "-e", "TERMINAL_STATE_PATH=/terminal/state.json", "-w", "/app/packages/exchanges",
           "--entrypoint", "node", image, "--input-type=module", "-e",
           "import {monitor} from './classic-monitor.mjs';process.argv.push('--once');"
           "const s=await monitor();console.log(JSON.stringify({markets:s.markets.map(m=>({status:m.status}))}));"))
    if len(snapshot["markets"]) != 2 or not all(market["status"] == "connected" for market in snapshot["markets"]):
        raise RuntimeError("Public market checks failed. Existing app is still running.")
    backup = original + "-rollback-" + args.commit[:12]
    monitor_backup = monitor + "-rollback-" + args.commit[:12]
    existing_monitor = bool(docker("ps", "-aq", "--filter", "name=^/" + monitor + "$"))
    monitor_environment = json.loads(docker("inspect", monitor))[0]["Config"]["Env"] if existing_monitor else []
    for mount in prior["Mounts"]:
        if mount["Type"] != "volume":
            raise ValueError("Unexpected existing mount")
    environment = prior["Config"]["Env"]
    configured_password = next((value.split("=", 1)[1] for value in environment
                                if value.startswith("ADMIN_PASSWORD=")), "")
    secret_directory = Path.home() / ".config" / "opentrader-terminal"
    secret_directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    secret_file = secret_directory / "admin-password.txt"
    if not secret_file.exists():
        descriptor = os.open(secret_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write((configured_password or secrets.token_urlsafe(32)) + "\n")
    password = secret_file.read_text().strip()
    if len(password) < 24 or "\n" in password:
        raise ValueError("Review the private administrator password file")
    if configured_password and configured_password != password:
        raise ValueError("Saved password differs from the existing administrator password")
    environment = [value for value in environment if not value.startswith("ADMIN_PASSWORD=")]
    environment.append("ADMIN_PASSWORD=" + password)
    env_path = release / "app.env"
    env_path.touch(mode=0o600)
    env_path.write_text("\n".join(environment) + "\n")
    monitor_env_path = release / "monitor.env"
    monitor_env_path.touch(mode=0o600)
    monitor_env_path.write_text("\n".join(monitor_environment) + "\n")
    try:
        docker("stop", original)
        # Database remains in the original volume. Keep a stopped predecessor for rollback.
        docker("rename", original, backup)
        run = ["run", "-d", "--name", original, "--restart", "unless-stopped",
               "--network", networks[0], "--env-file", str(env_path),
               "-e", "TERMINAL_STATE_PATH=/terminal/state.json",
               "-e", "TERMINAL_CREDENTIALS_PATH=/credentials/bitget.json"]
        for mount in prior["Mounts"]:
            if mount["Destination"] in ["/terminal", "/credentials"]:
                continue
            suffix = "" if mount["RW"] else ",readonly"
            run += ["--mount", f"type=volume,src={mount['Name']},dst={mount['Destination']}{suffix}"]
        run += ["--mount", f"type=volume,src={volume},dst=/terminal,readonly",
                "--mount", f"type=volume,src={credentials_volume},dst=/credentials",
                "-w", "/app/app", "--entrypoint", "node", image, "dist/standalone.mjs"]
        docker(*run)
        for _ in range(20):
            try:
                output = docker("exec", original, "node", "--input-type=module", "-e",
                    "const r=await fetch('http://127.0.0.1:8000/api/terminal/state',"
                    "{headers:{authorization:process.env.ADMIN_PASSWORD}});"
                    "if(!r.ok)process.exit(1);const s=await r.json();"
                    "console.log(JSON.stringify({mode:s.mode,markets:s.markets.length}));")
                if json.loads(output).get("markets") == 2:
                    break
            except subprocess.CalledProcessError:
                pass
            time.sleep(1)
        else:
            raise RuntimeError("New app health check failed")
        if existing_monitor:
            docker("stop", monitor)
            docker("rename", monitor, monitor_backup)
        docker("run", "-d", "--name", monitor, "--restart", "unless-stopped", "--env-file", str(monitor_env_path),
               "--mount", f"type=volume,src={volume},dst=/terminal",
               "--mount", f"type=volume,src={credentials_volume},dst=/credentials,readonly",
               "-e", "TERMINAL_STATE_PATH=/terminal/state.json",
               "-e", "TERMINAL_CREDENTIALS_PATH=/credentials/bitget.json",
               "-w", "/app/packages/exchanges", "--entrypoint", "node", image, "classic-monitor.mjs")
    except Exception:
        if docker("ps", "-aq", "--filter", "name=^/" + monitor_backup + "$"):
            if docker("ps", "-aq", "--filter", "name=^/" + monitor + "$"):
                docker("rm", "-f", monitor)
            docker("rename", monitor_backup, monitor)
            docker("start", monitor)
        if docker("ps", "-aq", "--filter", "name=^/" + backup + "$"):
            if docker("ps", "-aq", "--filter", "name=^/" + original + "$"):
                docker("rm", "-f", original)
            docker("rename", backup, original)
            docker("start", original)
        raise
    finally:
        env_path.unlink(missing_ok=True)
        monitor_env_path.unlink(missing_ok=True)
    print(json.dumps({"image": image, "rollbackContainer": backup, "commit": args.commit,
                      "monitor": monitor,
                      "passwordFile": str(secret_file)}))


if __name__ == "__main__":
    main()
