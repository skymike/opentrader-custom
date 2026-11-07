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
    parser.add_argument("--enable-ai", action="store_true", help="Initialize local commentary on first deployment")
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
    assistant = "opentrader-terminal-assistant"
    trader = "opentrader-terminal-trader"
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
        "COPY packages/exchanges/terminal-assistant.mjs /app/packages/exchanges/terminal-assistant.mjs\n"
        "COPY packages/exchanges/terminal-trading-store.mjs /app/packages/exchanges/terminal-trading-store.mjs\n"
        "COPY packages/exchanges/terminal-bitget.mjs /app/packages/exchanges/terminal-bitget.mjs\n"
        "COPY packages/exchanges/terminal-execution.mjs /app/packages/exchanges/terminal-execution.mjs\n"
        "COPY packages/exchanges/terminal-trader.mjs /app/packages/exchanges/terminal-trader.mjs\n"
        f"LABEL org.opencontainers.image.revision={args.commit}\n"
    )
    docker("build", "--network", "none", "-t", image, str(release))
    volume = "opentrader-terminal-state"
    credentials_volume = "opentrader-terminal-credentials"
    assistant_volume = "opentrader-terminal-assistant"
    trading_volume = "opentrader-terminal-trading"
    docker("volume", "create", trading_volume)
    docker("volume", "create", volume)
    docker("volume", "create", credentials_volume)
    docker("volume", "create", assistant_volume)
    if args.enable_ai:
        # Preserve a user's saved off preference during later upgrades.
        docker("run", "--rm", "--network", "none", "--mount", f"type=volume,src={assistant_volume},dst=/assistant",
               "--entrypoint", "node", image, "--input-type=module", "-e",
               "import{writeFile}from'node:fs/promises';import{randomUUID}from'node:crypto';"
               "try{await writeFile('/assistant/settings.json',JSON.stringify({enabled:true,revision:randomUUID()}),"
               "{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}")
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
    assistant_backup = assistant + "-rollback-" + args.commit[:12]
    trader_backup = trader + "-rollback-" + args.commit[:12]
    existing_trader = bool(docker("ps", "-aq", "--filter", "name=^/" + trader + "$"))
    existing_assistant = bool(docker("ps", "-aq", "--filter", "name=^/" + assistant + "$"))
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
        if existing_trader:
            docker("stop", "-t", "120", trader)
            docker("rename", trader, trader_backup)
        docker("stop", original)
        # Database remains in the original volume. Keep a stopped predecessor for rollback.
        docker("rename", original, backup)
        run = ["run", "-d", "--name", original, "--restart", "unless-stopped",
               "--network", networks[0], "--env-file", str(env_path),
               "-e", "TERMINAL_STATE_PATH=/terminal/state.json",
               "-e", "TERMINAL_CREDENTIALS_PATH=/credentials/bitget.json"]
        for mount in prior["Mounts"]:
            if mount["Destination"] in ["/terminal", "/credentials", "/assistant", "/trading"]:
                continue
            suffix = "" if mount["RW"] else ",readonly"
            run += ["--mount", f"type=volume,src={mount['Name']},dst={mount['Destination']}{suffix}"]
        run += ["--mount", f"type=volume,src={volume},dst=/terminal,readonly",
                "--mount", f"type=volume,src={credentials_volume},dst=/credentials",
                "--mount", f"type=volume,src={assistant_volume},dst=/assistant",
                "--mount", f"type=volume,src={trading_volume},dst=/trading",
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
        docker("run", "-d", "--name", trader, "--restart", "unless-stopped",
               "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "--memory", "256m", "--pids-limit", "64",
               "--mount", f"type=volume,src={volume},dst=/terminal,readonly",
               "--mount", f"type=volume,src={credentials_volume},dst=/credentials,readonly",
               "--mount", f"type=volume,src={trading_volume},dst=/trading",
               "-w", "/app/packages/exchanges", "--entrypoint", "node", image, "terminal-trader.mjs")
        if existing_assistant:
            docker("stop", assistant)
            docker("rename", assistant, assistant_backup)
        # Always install the idle worker so the UI switch also works after recovery/redeployment.
        docker("run", "-d", "--name", assistant, "--restart", "unless-stopped",
               "--network", "host", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "--cpus", "0.25", "--cpu-shares", "128", "--cpuset-cpus", "2,3",
               "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "64",
               "--mount", f"type=volume,src={volume},dst=/terminal,readonly",
               "--mount", f"type=volume,src={assistant_volume},dst=/assistant",
               "-w", "/app/packages/exchanges", "--entrypoint", "node", image, "terminal-assistant.mjs")
    except Exception:
        if docker("ps", "-aq", "--filter", "name=^/" + trader + "$"):
            docker("rm", "-f", trader)
        if docker("ps", "-aq", "--filter", "name=^/" + trader_backup + "$"):
            docker("rename", trader_backup, trader)
            docker("start", trader)
        if docker("ps", "-aq", "--filter", "name=^/" + assistant_backup + "$"):
            if docker("ps", "-aq", "--filter", "name=^/" + assistant + "$"):
                docker("rm", "-f", assistant)
            docker("rename", assistant_backup, assistant)
            docker("start", assistant)
        elif not existing_assistant and docker("ps", "-aq", "--filter", "name=^/" + assistant + "$"):
            docker("rm", "-f", assistant)
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
                      "monitor": monitor, "trader": trader,
                      "passwordFile": str(secret_file)}))


if __name__ == "__main__":
    main()
