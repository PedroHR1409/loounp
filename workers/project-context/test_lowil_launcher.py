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
PACKAGED_PYTHON = Path(os.environ.get("APPDATA", "")) / "content-discovery-poc" / "article-to-project" / "runtime" / "venv" / "Scripts" / "python.exe"
PACKAGED_BASE = PACKAGED_PYTHON.parent.parent.parent / "python-base" / "python.exe"
LAUNCH_PYTHON = str(PACKAGED_PYTHON if PACKAGED_PYTHON.is_file() else Path(sys.executable))

PROBE = r'''
import ctypes, json, msvcrt, os, socket, subprocess, sys
from ctypes import wintypes
source, report = sys.argv[1], sys.argv[2]
sys.path.insert(0, sys.argv[3])
results = {"pid": os.getpid(), "env_has_key": any(k in os.environ for k in ("OPENAI_API_KEY", "GITHUB_TOKEN"))}
results["root_real"] = os.path.realpath(source)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel32.CreateFileW.restype = wintypes.HANDLE
get_final_path = kernel32.GetFinalPathNameByHandleW
get_final_path.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
get_final_path.restype = wintypes.DWORD
root_handle = kernel32.CreateFileW(source, 0x80, 0x1 | 0x2 | 0x4, None, 3, 0x02000000, None)
results["root_handle"] = "ok" if root_handle != wintypes.HANDLE(-1).value else "error:" + str(ctypes.get_last_error())
if root_handle != wintypes.HANDLE(-1).value:
    root_buffer = ctypes.create_unicode_buffer(32768)
    root_length = get_final_path(root_handle, root_buffer, 32768, 4)
    results["root_final"] = root_buffer.value if root_length else "error:" + str(ctypes.get_last_error())
    kernel32.CloseHandle(root_handle)
target = os.path.join(source, "README.md")
try:
    results["read"] = open(target, encoding="utf-8").read()
except Exception as error:
    results["read"] = "FAIL " + type(error).__name__
fd = os.open(target, os.O_RDONLY)
buffer = ctypes.create_unicode_buffer(32768)
length = get_final_path(msvcrt.get_osfhandle(fd), buffer, 32768, 4)
results["final_path"] = buffer.value if length else "error:" + str(ctypes.get_last_error())
os.close(fd)
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
try:
    socket.create_connection(("1.1.1.1", 443), timeout=3)
    results["network_os"] = "SUCCEEDED"
except PermissionError:
    results["network_os"] = "blocked:PermissionError"
except Exception as error:
    results["network_os"] = "error: " + type(error).__name__
from pathlib import Path
import worker
try:
    root_from_worker = worker.final_path_of_directory(source)
    results["worker_root_path"] = root_from_worker
    results["worker_safe_read"] = worker.safe_read(root_from_worker, Path(target), 1024 * 1024)[0].decode("utf-8")
except Exception as error:
    results["worker_root_path"] = "error:" + type(error).__name__ + ":" + str(error)
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

PATH_PROBE = r'''
import json, sys
from pathlib import Path
source, report, modules = sys.argv[1:4]
sys.path.insert(0, modules)
import worker
root = worker.final_path_of_directory(source)
content, _ = worker.safe_read(root, Path(source) / "demo" / "README.md", 1024 * 1024)
Path(report).parent.mkdir(parents=True, exist_ok=True)
Path(report).write_text(json.dumps({"root": root, "content": content.decode("utf-8")}), encoding="utf-8")
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


@unittest.skipUnless(os.name == "nt" and LOCAL_LOW.is_dir() and PACKAGED_BASE.is_file(), "requires the packaged AppContainer runtime")
class LowIntegrityBarrierTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="a2p-barrier-"))
        self.assertFalse(os.path.normcase(os.path.realpath(self.base)).startswith(PROTECTED))
        self.source = self.base / "source"
        self.source.mkdir()
        (self.source / "README.md").write_text("# Fixture\n", encoding="utf-8")
        self.probe_modules = self.base / "probe-modules"
        self.probe_modules.mkdir()
        shutil.copy2(HERE / "sandbox_guard.py", self.probe_modules / "sandbox_guard.py")
        shutil.copy2(HERE / "worker.py", self.probe_modules / "worker.py")
        self.probe = self.base / "probe.py"
        self.probe.write_text(PROBE, encoding="utf-8")
        self.path_probe = self.base / "path_probe.py"
        self.path_probe.write_text(PATH_PROBE, encoding="utf-8")
        self.workdir = LOCAL_LOW / "a2p-tests" / self.base.name
        self.report = self.workdir / "exchange" / "report.json"

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)
        shutil.rmtree(self.workdir, ignore_errors=True)

    def launcher(self, *extra):
        return [LAUNCH_PYTHON, "-I", str(HERE / "lowil_launcher.py"), "--python", LAUNCH_PYTHON, "--entry", str(self.probe), "--workdir", str(self.workdir),
                "--read-path", str(self.source), "--read-path", str(self.probe_modules), "--",
                str(self.source), str(self.report), str(self.probe_modules), *extra]

    def test_child_reads_but_cannot_write_and_guard_blocks_network(self):
        before = snapshot(self.source)
        env = {**os.environ, "OPENAI_API_KEY": "sk-should-not-leak"}
        completed = subprocess.run(self.launcher(), capture_output=True, text=True, timeout=120, env=env)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        results = json.loads(self.report.read_text(encoding="utf-8"))
        self.assertEqual(results["read"], "# Fixture\n")
        self.assertEqual(results["worker_safe_read"].replace("\r\n", "\n"), "# Fixture\n", results["worker_root_path"])
        self.assertEqual(results["root_handle"], "ok", results["root_handle"])
        self.assertTrue(results["final_path"].endswith("README.md"), results["final_path"])
        self.assertTrue(results["root_final"].endswith("source"), results["root_final"])
        for attempt in ("create", "edit", "truncate", "delete", "rename", "mkdir", "chmod", "child_write", "icacls", "junction", "network_os", "network_after_guard", "process_after_guard"):
            if attempt == "network_os":
                self.assertEqual(results[attempt], "blocked:PermissionError", attempt)
            else:
                self.assertEqual(results[attempt], "blocked", attempt)
        self.assertFalse(results["env_has_key"])
        self.assertEqual(snapshot(self.source), before)

    def test_appcontainer_path_validation_works_for_nested_project_files(self):
        (self.source / "demo").mkdir()
        (self.source / "demo" / "README.md").write_text("# Nested\n", encoding="utf-8")
        command = [LAUNCH_PYTHON, "-I", str(HERE / "lowil_launcher.py"), "--python", LAUNCH_PYTHON,
                   "--entry", str(self.path_probe), "--workdir", str(self.workdir),
                   "--read-path", str(self.source), "--read-path", str(self.probe_modules), "--",
                   str(self.source), str(self.report), str(self.probe_modules)]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=120)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(self.report.read_text(encoding="utf-8"))
        self.assertEqual(result["content"].replace("\r\n", "\n"), "# Nested\n")

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
        command = [LAUNCH_PYTHON, "-I", str(HERE / "lowil_launcher.py"), "--python", LAUNCH_PYTHON, "--entry", str(HERE / "worker.py"), "--workdir", str(self.workdir),
                   "--read-path", str(self.source), "--read-path", str(inputs), "--write-path", str(exchange), "--",
                   "--input", str(inputs), "--exchange", str(exchange), "--source", str(self.source)]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=180)
        status_path = exchange / "status.json"
        detail = status_path.read_text(encoding="utf-8") if status_path.exists() else completed.stderr
        self.assertEqual(completed.returncode, 0, detail)
        status = json.loads((exchange / "status.json").read_text(encoding="utf-8"))
        self.assertIn(status["state"], {"completed", "partial"})
        project = json.loads((exchange / "project-0.json").read_text(encoding="utf-8"))
        self.assertIn("demo/README.md", {item["relativePath"] for item in project["files"]}, json.dumps({"status": status, "project": project}))
        self.assertEqual(project["graph"]["status"], "ok", project["graph"])
        self.assertEqual(snapshot(self.source), before)

    def test_killing_the_launcher_kills_the_job(self):
        process = subprocess.Popen(self.launcher("60"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 60
        report = None
        while report is None and time.time() < deadline:
            try:
                report = json.loads(self.report.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                time.sleep(0.05)
        self.assertIsNotNone(report, "worker did not publish its process report")
        pid = report["pid"]
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
