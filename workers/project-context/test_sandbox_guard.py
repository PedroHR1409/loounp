import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).parent

SCRIPT = r'''
import json, subprocess, sys, socket
sys.path.insert(0, sys.argv[1])
import sandbox_guard
sandbox_guard.install(allowed_executables=(sys.executable,))
results = {}
def attempt(name, op):
    try:
        op(); results[name] = "allowed"
    except sandbox_guard.GuardViolation:
        results[name] = "blocked"
attempt("network", lambda: socket.create_connection(("127.0.0.1", 9), timeout=1))
attempt("dns", lambda: socket.getaddrinfo("example.com", 443))
attempt("other_process", lambda: subprocess.run(["cmd", "/c", "echo"], capture_output=True))
attempt("os_system", lambda: __import__("os").system("echo"))
attempt("own_interpreter", lambda: subprocess.run([sys.executable, "-c", "pass"], check=True))
print(json.dumps(results))
'''


class GuardTests(unittest.TestCase):
    def test_blocks_network_and_foreign_processes_but_allows_own_interpreter(self):
        completed = subprocess.run([sys.executable, "-I", "-c", SCRIPT, str(HERE)], capture_output=True, text=True, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        results = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(results, {"network": "blocked", "dns": "blocked", "other_process": "blocked", "os_system": "blocked", "own_interpreter": "allowed"})

    def test_run_module_entry_point_installs_the_guard(self):
        completed = subprocess.run([sys.executable, "-I", str(HERE / "sandbox_guard.py"), "--run-module", "json.tool", "--help"], capture_output=True, text=True, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("usage", completed.stdout.lower())


if __name__ == "__main__":
    unittest.main()
