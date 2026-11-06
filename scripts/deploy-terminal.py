"""Deploy a verified GitHub terminal artifact over the existing OpenTrader image."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
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
        f"LABEL org.opencontainers.image.revision={args.commit}\n"
    )
    docker("build", "--network", "none", "-t", image, str(release))
    volume = "opentrader-terminal-state"
    docker("volume", "create", volume)
    # Run the public market collector once before replacing the app.
    docker("run", "--rm", "--mount", f"type=volume,src={volume},dst=/terminal",
           "-e", "TERMINAL_STATE_PATH=/terminal/state.json", "-w", "/app/packages/exchanges",
           "--entrypoint", "node", image, "classic-monitor.mjs", "--once")
    snapshot = json.loads(docker("run", "--rm", "--network", "none",
        "--mount", f"type=volume,src={volume},dst=/terminal,readonly",
        "--entrypoint", "cat", image, "/terminal/state.json"))
    if not all(market["status"] == "connected" for market in snapshot["markets"]):
        raise RuntimeError("Public market checks failed. Existing app is still running.")
    backup = original + "-rollback-" + args.commit[:12]
    if docker("ps", "-aq", "--filter", "name=^/" + monitor + "$"):
        raise RuntimeError("A monitor already exists. Review its credentials before replacing it.")
    environment = prior["Config"]["Env"]
    env_path = release / "app.env"
    env_path.touch(mode=0o600)
    env_path.write_text("\n".join(environment) + "\n")
    try:
        docker("stop", original)
        # Database remains in the original volume. Keep a stopped predecessor for rollback.
        docker("rename", original, backup)
        run = ["run", "-d", "--name", original, "--restart", "unless-stopped",
               "--network", networks[0], "--env-file", str(env_path),
               "-e", "TERMINAL_STATE_PATH=/terminal/state.json"]
        for mount in prior["Mounts"]:
            if mount["Type"] != "volume":
                raise ValueError("Unexpected existing mount")
            run += ["--mount", f"type=volume,src={mount['Name']},dst={mount['Destination']}"]
        run += ["--mount", f"type=volume,src={volume},dst=/terminal,readonly",
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
        docker("run", "-d", "--name", monitor, "--restart", "unless-stopped",
               "--mount", f"type=volume,src={volume},dst=/terminal",
               "-e", "TERMINAL_STATE_PATH=/terminal/state.json",
               "-w", "/app/packages/exchanges", "--entrypoint", "node", image, "classic-monitor.mjs")
    except Exception:
        if docker("ps", "-aq", "--filter", "name=^/" + backup + "$"):
            if docker("ps", "-aq", "--filter", "name=^/" + original + "$"):
                docker("rm", "-f", original)
            docker("rename", backup, original)
            docker("start", original)
        raise
    finally:
        env_path.unlink(missing_ok=True)
    print(json.dumps({"image": image, "rollbackContainer": backup, "commit": args.commit,
                      "account": "not-connected", "monitor": monitor}))


if __name__ == "__main__":
    main()
