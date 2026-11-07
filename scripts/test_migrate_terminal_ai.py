import importlib.util
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("migration", Path(__file__).with_name("migrate-terminal-ai.py"))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def test_cleanup_requires_post_cutover_result_and_preserves_other_files(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            unit = home / ".config/systemd/user/opentrader-lfm.service"
            unit.parent.mkdir(parents=True)
            unit.write_text("old model unit")
            marker = home / ".config/opentrader-ai-link/cutover.json"
            marker.parent.mkdir(parents=True)
            cutover = time.time()*1000
            marker.write_text(json.dumps({"at": cutover}))
            production = home / ".local/share/opentrader-ai"
            production.mkdir(parents=True)
            (production / "model.gguf").write_text("weights")
            (production / "llama-server").write_text("runner")
            benchmark = home / "ai-benchmark-20261107/models"
            benchmark.mkdir(parents=True)
            lfm = benchmark / "LFM2.5-1.2B-Instruct-Q4_K_M.gguf"
            lfm.write_text("weights")
            unrelated = benchmark / "qwen.gguf"
            unrelated.write_text("leave this alone")
            generated_at = cutover - 1000
            def command(*args):
                if args[0] == "docker":
                    return json.dumps({"status": "ready", "generatedAt": generated_at})
                return "active"
            with patch.object(Path, "home", return_value=home), patch.object(migration, "run", side_effect=command), patch.object(migration, "health"):
                with self.assertRaisesRegex(RuntimeError, "fresh completed"):
                    migration.cleanup_nl()
                self.assertTrue(unit.exists())
                self.assertTrue(lfm.exists())
                generated_at = cutover + 1
                migration.cleanup_nl()
                self.assertFalse(unit.exists())
                self.assertFalse(production.exists())
                self.assertFalse(lfm.exists())
                self.assertEqual(unrelated.read_text(), "leave this alone")

    def test_failed_tunnel_restores_local_model(self):
        commands = []
        with patch.object(migration, "run", side_effect=lambda *args: commands.append(args)), \
                patch.object(migration, "health", side_effect=RuntimeError("unreachable")), \
                patch.object(migration.subprocess, "run", side_effect=lambda args, **kwargs: commands.append(tuple(args))):
            with self.assertRaisesRegex(RuntimeError, "unreachable"):
                migration.switch_link()
        self.assertEqual(commands[-1], ("systemctl", "--user", "start", "opentrader-lfm"))
        self.assertEqual(commands[-2], ("systemctl", "--user", "disable", "--now", "opentrader-lfm-link"))

    def test_failed_proud_install_unwinds_and_can_be_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def rooted(value): return root / str(value).lstrip("/")
            benchmark = rooted('/root/proud-lfm-benchmark-20261107')
            benchmark.mkdir(parents=True)
            (benchmark/'summary.json').write_text('{"passed":true}')
            (benchmark/'lfm.gguf').write_text('fixture weights')
            runner = rooted('/root/proud-ai-benchmark-20261107/runner/llama-b12110')
            runner.mkdir(parents=True)
            (runner/'llama-server').write_text('fixture runner')
            for parent in ['/opt', '/etc/ssh/sshd_config.d', '/etc/systemd/system']:
                rooted(parent).mkdir(parents=True, exist_ok=True)
            key = root/'client.pub'
            key.write_text('ssh-ed25519 AAAA fixture')
            account = SimpleNamespace(pw_dir='/var/lib/opentrader-ai', pw_uid=123)
            with patch.object(migration, 'Path', side_effect=rooted), patch.object(migration.os, 'geteuid', return_value=0), \
                 patch.object(migration.pwd, 'getpwnam', return_value=account), patch.object(migration, 'verify'), \
                 patch.object(migration, 'run'), patch.object(migration.subprocess, 'run'), \
                 patch.object(migration, 'health', side_effect=[RuntimeError('model failed'), None]):
                with self.assertRaisesRegex(RuntimeError, 'model failed'):
                    migration.install_proud(key)
                self.assertFalse(rooted('/opt/opentrader-lfm').exists())
                self.assertFalse(rooted('/etc/systemd/system/opentrader-lfm.service').exists())
                self.assertFalse(rooted('/etc/ssh/sshd_config.d/70-opentrader-ai.conf').exists())
                migration.install_proud(key)
                self.assertTrue(rooted('/opt/opentrader-lfm/model.gguf').exists())


if __name__ == "__main__":
    unittest.main()
