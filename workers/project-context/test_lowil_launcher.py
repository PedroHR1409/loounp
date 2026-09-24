import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import lowil_launcher  # noqa: E402

HERE = Path(__file__).parent
PROTECTED = os.path.normcase(os.path.realpath(os.path.join(os.environ.get("USERPROFILE", ""), "Desktop", "Projetos")))
LOCAL_LOW = Path(os.environ.get("USERPROFILE", "")) / "AppData" / "LocalLow"

PROBE = r'''
import json, os, subprocess, sys
source, report = sys.argv[1], sys.argv[2]
sys.path.insert(0, sys.argv[3])
results = {"pid": os.getpid(), "env_has_key": any(k in os.environ for k in ("OPENAI_API_KEY", "GITHUB_TOKEN"))}
target = os.path.join(source, "README.md")
try:
    results["read"] = open(target, encoding="utf-8").read()
except Exception as error:
    results["read"] = "FAIL " + type(error).__name__
def attempt(name, op):
    try:
        op(); results[name] = "SUCCEEDED"
    except Exception:
        results[name] = "blocked"
attempt("create", lambda: open(os.path.join(source, "new.txt"), "w").write("x"))
attempt("edit", lambda: open(target, "a").write("x"))
attempt("truncate", lambda: open(target, "w").close())
attempt("delete", lambda: os.remove(target))
attempt("rename", lambda: os.rename(target, target + ".moved"))
attempt("mkdir", lambda: os.mkdir(os.path.join(source, "d")))
attempt("chmod", lambda: os.chmod(target, 0o444))
attempt("child_write", lambda: subprocess.run(["cmd", "/c", "echo x> " + os.path.join(source, "child.txt")], check=True, capture_output=True))
attempt("icacls", lambda: subprocess.run(["icacls", target, "/deny", "Everyone:R"], check=True, capture_output=True))
attempt("junction", lambda: subprocess.run(["cmd", "/c", "mklink", "/J", os.path.join(source, "j"), os.environ["SYSTEMROOT"]], check=True, capture_output=True))
import sandbox_guard
sandbox_guard.install()
import socket
attempt("network_after_guard", lambda: socket.create_connection(("example.com", 443), timeout=5))
attempt("process_after_guard", lambda: subprocess.run(["cmd", "/c", "echo"], check=True))
os.makedirs(os.path.dirname(report), exist_ok=True)
open(report, "w", encoding="utf-8").write(json.dumps(results))
if len(sys.argv) > 4:
    import time; time.sleep(float(sys.argv[4]))
'''


def snapshot(root: Path):
    return {str(p.relative_to(root)): (p.is_file() and p.read_bytes(), p.stat().st_mtime_ns, os.stat(p).st_file_attributes) for p in sorted(root.rglob("*"))}


def process_alive(pid: int) -> bool:
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    code = ctypes.c_ulong()
    ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(handle)
    return code.value == 259


@unittest.skipUnless(os.name == "nt" and LOCAL_LOW.is_dir(), "Windows low-integrity barrier")
class LowIntegrityBarrierTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="a2p-barrier-"))
        self.assertFalse(os.path.normcase(os.path.realpath(self.base)).startswith(PROTECTED))
        self.source = self.base / "source"
        self.source.mkdir()
        (self.source / "README.md").write_text("# Fixture\n", encoding="utf-8")
        self.probe = self.base / "probe.py"
        self.probe.write_text(PROBE, encoding="utf-8")
        self.workdir = LOCAL_LOW / "a2p-tests" / self.base.name
        self.report = self.workdir / "exchange" / "report.json"

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)
        shutil.rmtree(self.workdir, ignore_errors=True)

    def launcher(self, *extra):
        return [sys.executable, "-I", str(HERE / "lowil_launcher.py"), "--python", sys.executable, "--entry", str(self.probe), "--workdir", str(self.workdir), "--",
                str(self.source), str(self.report), str(HERE), *extra]

    def test_child_reads_but_cannot_write_and_guard_blocks_network(self):
        before = snapshot(self.source)
        env = {**os.environ, "OPENAI_API_KEY": "sk-should-not-leak"}
        completed = subprocess.run(self.launcher(), capture_output=True, text=True, timeout=120, env=env)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        results = json.loads(self.report.read_text(encoding="utf-8"))
        self.assertEqual(results["read"], "# Fixture\n")
        for attempt in ("create", "edit", "truncate", "delete", "rename", "mkdir", "chmod", "child_write", "icacls", "junction", "network_after_guard", "process_after_guard"):
            self.assertEqual(results[attempt], "blocked", attempt)
        self.assertFalse(results["env_has_key"])
        self.assertEqual(snapshot(self.source), before)

    def test_real_worker_cli_runs_at_low_integrity_and_publishes_protocol_files(self):
        (self.source / "demo").mkdir()
        (self.source / "demo" / "README.md").write_text("# Demo\n\nBusca BM25.\n", encoding="utf-8")
        (self.source / "demo" / "app.py").write_text("def main():\n    return 1\n", encoding="utf-8")
        before = snapshot(self.source)
        inputs = self.base / "input"
        inputs.mkdir()
        (inputs / "request.json").write_text(json.dumps({"contract": "v1", "jobId": "job_clitest01", "seq": 1, "op": "catalog", "params": {}}), encoding="utf-8")
        exchange = self.workdir / "exchange"
        exchange.mkdir(parents=True)
        command = [sys.executable, "-I", str(HERE / "lowil_launcher.py"), "--python", sys.executable, "--entry", str(HERE / "worker.py"), "--workdir", str(self.workdir), "--",
                   "--input", str(inputs), "--exchange", str(exchange), "--source", str(self.source)]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=180)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        status = json.loads((exchange / "status.json").read_text(encoding="utf-8"))
        self.assertIn(status["state"], {"completed", "partial"})
        project = json.loads((exchange / "project-0.json").read_text(encoding="utf-8"))
        self.assertIn("demo/README.md", {item["relativePath"] for item in project["files"]})
        self.assertIn(project["graph"]["status"], {"ok", "unavailable", "failed"})
        self.assertEqual(snapshot(self.source), before)

    def test_killing_the_launcher_kills_the_job(self):
        process = subprocess.Popen(self.launcher("60"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 60
        while not self.report.exists() and time.time() < deadline:
            time.sleep(0.2)
        pid = json.loads(self.report.read_text(encoding="utf-8"))["pid"]
        self.assertTrue(process_alive(pid))
        process.kill()
        process.wait(timeout=10)
        deadline = time.time() + 5
        while process_alive(pid) and time.time() < deadline:
            time.sleep(0.1)
        self.assertFalse(process_alive(pid), "worker survived launcher termination")


class QuoteTests(unittest.TestCase):
    def test_windows_argument_quoting(self):
        self.assertEqual(lowil_launcher.quote("plain"), "plain")
        self.assertEqual(lowil_launcher.quote(r"C:\Users\A B\x"), r'"C:\Users\A B\x"')
        self.assertEqual(lowil_launcher.quote('a"b'), r'"a\"b"')
        self.assertEqual(lowil_launcher.quote("dir\\ "), '"dir\\ "')
        self.assertEqual(lowil_launcher.quote("C:\\A B\\"), '"C:\\A B\\\\"')


if __name__ == "__main__":
    unittest.main()
