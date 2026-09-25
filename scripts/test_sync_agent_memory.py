#!/usr/bin/env python3
"""Behavior checks for sync-agent-memory using isolated local homes."""

from __future__ import annotations

import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("sync-agent-memory")
MARKER = "[redacted by sync-agent-memory]"


def file_hashes(root: Path) -> dict[str, str]:
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file()}


class SyncAgentMemoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.homes = {name: self.root / name for name in ("A", "B", "C")}
        for home in self.homes.values():
            home.mkdir()
        self.state = self.root / "state"
        self.rsync_trace = self.root / "rsync-trace.jsonl"
        self.rsync_bin = self.root / "bin"
        self.rsync_bin.mkdir()
        wrapper = self.rsync_bin / "rsync"
        wrapper.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, subprocess, sys\n"
            "with open(os.environ['SYNC_TEST_RSYNC_TRACE'], 'a') as output:\n"
            "    output.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "raise SystemExit(subprocess.call([os.environ['SYNC_TEST_REAL_RSYNC'], *sys.argv[1:]]))\n",
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
        self.real_rsync = shutil.which("rsync")
        self.assertIsNotNone(self.real_rsync)

        self.put("A", ".claude/projects/-p1/memory/MEMORY.md", "# A index\n- [A](a1.md) — A hook\n")
        self.put("A", ".claude/projects/-p1/memory/a1.md", "A topic\n")
        self.put("A", ".claude/projects/-p1/session.jsonl", '{"private":"transcript"}\n')
        self.put("A", ".claude/projects/-p3/memory/x.md", "A version\n")
        self.put("A", ".codex/memories/MEMORY.md", "A codex\nsk-ABCDEFGHIJKLMNOPQRSTUVWX\n")
        self.put("A", ".codex/memories/memory_summary.md", "A summary\n")
        self.put("A", ".codex/memories/raw_memories.md", "excluded raw\n")
        self.put("A", ".codex/memories/rollout_summaries/r1.md", "rollout\n")
        self.put("A", ".codex/memories/skills/s1/SKILL.md", "skill\n")
        self.put("A", ".codex/memories/.git/HEAD", "ref: refs/heads/main\n")
        self.put("A", ".codex/memories/extensions/ad_hoc/notes/n.md", "excluded extension\n")

        self.put("B", ".claude/projects/-p1/memory/MEMORY.md", "# B index\n- [B](b1.md) — B hook\n")
        self.put("B", ".claude/projects/-p1/memory/b1.md", "B topic\n")
        self.put("B", ".claude/projects/-p2/memory/MEMORY.md", "# Notes\n- Sudo password: hunter22secret\n")
        self.put("B", ".claude/projects/-p3/memory/x.md", "B version\n")
        self.put("B", ".codex/memories/MEMORY.md", "B codex\n")
        self.put("B", ".codex/memories/memory_summary.md", "B summary\n")

    def put(self, host: str, relative: str, content: str) -> None:
        path = self.homes[host] / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def run_sync(self, *extra: str) -> subprocess.CompletedProcess[str]:
        command = [sys.executable, str(SCRIPT)]
        for name, home in self.homes.items():
            command.extend(("--host", f"{name}={home}"))
        command.extend(("--state-dir", str(self.state), *extra))
        environment = os.environ.copy()
        environment["PATH"] = str(self.rsync_bin) + os.pathsep + environment.get("PATH", "")
        environment["SYNC_TEST_RSYNC_TRACE"] = str(self.rsync_trace)
        environment["SYNC_TEST_REAL_RSYNC"] = self.real_rsync
        return subprocess.run(command, capture_output=True, text=True, env=environment)

    def read(self, host: str, relative: str) -> str:
        return (self.homes[host] / relative).read_text(encoding="utf-8")

    def test_dry_run_apply_and_retry(self) -> None:
        originals = {name: file_hashes(home) for name, home in self.homes.items()}
        a_index = self.read("A", ".claude/projects/-p1/memory/MEMORY.md")
        b_index = self.read("B", ".claude/projects/-p1/memory/MEMORY.md")
        b_notes = self.read("B", ".claude/projects/-p2/memory/MEMORY.md")

        dry = self.run_sync()
        self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
        self.assertRegex(dry.stdout, r"copies=[1-9]")
        for name, home in self.homes.items():
            self.assertEqual(file_hashes(home), originals[name], f"dry run changed {name}")

        applied = self.run_sync("--apply")
        self.assertEqual(applied.returncode, 0, applied.stdout + applied.stderr)
        self.assertEqual(self.read("C", ".claude/projects/-p1/memory/a1.md"), "A topic\n")
        self.assertEqual(self.read("C", ".claude/projects/-p1/memory/b1.md"), "B topic\n")
        c_index = self.read("C", ".claude/projects/-p1/memory/MEMORY.md")
        self.assertIn("- [A](a1.md) — A hook (from A)\n", c_index)
        self.assertIn("- [B](b1.md) — B hook (from B)\n", c_index)
        self.assertEqual(self.read("A", ".claude/projects/-p1/memory/b1.md"), "B topic\n")
        for name, slug in (("C", "-p1"), ("A", "-p2")):
            mode = (self.homes[name] / ".claude/projects" / slug).stat().st_mode & 0o777
            self.assertEqual(mode, 0o700, f"new project directory mode on {name}")
        self.assertEqual(self.read("A", ".claude/projects/-p1/memory/MEMORY.md"),
                         a_index + "- [B](b1.md) — B hook (from B)\n")
        self.assertEqual(self.read("B", ".claude/projects/-p1/memory/MEMORY.md"),
                         b_index + "- [A](a1.md) — A hook (from A)\n")

        for name in ("A", "C"):
            self.assertEqual(self.read(name, ".claude/projects/-p2/memory/MEMORY.md"),
                             "# Notes\n- Sudo password: " + MARKER + "\n")
        self.assertEqual(self.read("B", ".claude/projects/-p2/memory/MEMORY.md"), b_notes)
        self.assertFalse((self.homes["B"] / ".claude/projects/-p1/session.jsonl").exists())
        self.assertFalse((self.homes["C"] / ".claude/projects/-p1/session.jsonl").exists())
        self.assertFalse((self.homes["C"] / ".claude/projects/-p3/memory/x.md").exists())
        self.assertIn("conflict: C -p3/memory/x.md", applied.stdout)

        self.assertEqual(self.read("A", ".agent-memory/peers/B/codex/MEMORY.md"), "B codex\n")
        peer_a = self.homes["C"] / ".agent-memory/peers/A/codex"
        self.assertEqual({str(path.relative_to(peer_a)) for path in peer_a.rglob("*") if path.is_file()},
                         {"MEMORY.md", "memory_summary.md", "rollout_summaries/r1.md",
                          "skills/s1/SKILL.md"})
        self.assertEqual((peer_a / "MEMORY.md").read_text(encoding="utf-8"),
                         "A codex\n" + MARKER + "\n")
        for name, home in self.homes.items():
            self.assertFalse((home / ".agent-memory/peers/C").exists())
            current_hashes = file_hashes(home)
            for path, digest in originals[name].items():
                if path == ".claude/projects/-p1/memory/MEMORY.md":
                    continue
                self.assertEqual(current_hashes[path], digest,
                                 f"existing source memory changed on {name}: {path}")

        before_retry = {name: file_hashes(home) for name, home in self.homes.items()}
        retry = self.run_sync("--apply")
        self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)
        self.assertTrue(re.findall(r"copies=0 appends=0", retry.stdout), retry.stdout)
        self.assertFalse(re.search(r"copies=[1-9]|appends=[1-9]", retry.stdout), retry.stdout)
        self.assertFalse(re.search(r"mirror changes: .*: [1-9]", retry.stdout), retry.stdout)
        for name, home in self.homes.items():
            self.assertEqual(file_hashes(home), before_retry[name], f"retry changed {name}")

        calls = [json.loads(line) for line in self.rsync_trace.read_text(encoding="utf-8").splitlines()]
        deletion_targets = [call[-1] for call in calls if "--delete" in call]
        self.assertTrue(deletion_targets)
        allowed_peer_roots = [str(home / ".agent-memory/peers") for home in self.homes.values()]
        for target in deletion_targets:
            self.assertTrue(target.startswith(str(self.state / "stage") + "/") or
                            any(target.startswith(peer + "/") for peer in allowed_peer_roots), target)
        copy_calls = [call for call in calls if "--ignore-existing" in call]
        self.assertTrue(copy_calls)
        self.assertTrue(all("-rlt" in call and "--mkpath" in call for call in copy_calls))

    def test_redaction_rules(self) -> None:
        sys.dont_write_bytecode = True
        loader = importlib.machinery.SourceFileLoader("sync_agent_memory_under_test", str(SCRIPT))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        self.addCleanup(sys.modules.pop, spec.name, None)
        loader.exec_module(module)
        line = "password: " + MARKER + "\n"
        self.assertEqual(module.redact_text(line), (line, []))
        for text in ("token=<your-token>\n", "token=${MOVIDESK_TOKEN}\n",
                     "branch task-160534-aspect-implantation-cost-draft\n",
                     "GET /storage/download?token=&id=<uuid>\n",
                     "GET /v1/tickets?token=...&is=...\n", "GET /download?token=TOKEN&id=<file-id>\n"):
            self.assertEqual(module.redact_text(text), (text, []))
        secrets =("password: hunter22secret\n"
                   "ghp_ABCDEFGHIJKLMNOPQRSTUVWX\n"
                   "plane_api_0123456789abcdef0123456789abcdef\n")
        redacted, lines = module.redact_text(secrets)
        self.assertEqual(redacted, ("password: " + MARKER + "\n" + MARKER + "\n" + MARKER + "\n"))
        self.assertEqual(lines, [1, 2, 3])


if __name__ == "__main__":
    unittest.main()
