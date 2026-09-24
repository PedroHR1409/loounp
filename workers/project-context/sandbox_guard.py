"""Application-level guard: refuses network and unapproved process creation.

This is a defense-in-depth layer installed with sys.addaudithook; it cannot be
removed once installed. The write barrier itself comes from the low-integrity
token applied by lowil_launcher.py, not from this module.
"""
from __future__ import annotations

import os
import runpy
import sys

NETWORK_EVENTS = {"socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg"}
PROCESS_EVENTS = {"subprocess.Popen", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.startfile", "_winapi.CreateProcess"}

_installed = False


class GuardViolation(RuntimeError):
    pass


def _normalize(path: object) -> str:
    return os.path.normcase(os.path.abspath(os.fsdecode(path))) if isinstance(path, (str, bytes, os.PathLike)) else ""


def _program(args: tuple) -> object:
    executable = args[0] if args else None
    if executable or len(args) < 2:
        return executable
    command = args[1]
    if isinstance(command, (list, tuple)):
        return command[0] if command else None
    text = os.fsdecode(command).lstrip()
    if text.startswith('"'):
        return text[1:].split('"', 1)[0]
    return text.split(" ", 1)[0]


def install(allowed_executables: tuple[str, ...] = ()) -> None:
    global _installed
    if _installed:
        return
    allowed = {_normalize(item) for item in allowed_executables}

    pending = {"approved": False}

    def hook(event: str, args: tuple) -> None:
        if event in NETWORK_EVENTS:
            raise GuardViolation(f"network blocked: {event}")
        if event == "subprocess.Popen":
            if _normalize(_program(args)) not in allowed:
                raise GuardViolation("process blocked: subprocess.Popen")
            pending["approved"] = True
            return
        if event == "_winapi.CreateProcess":
            if not pending["approved"]:
                raise GuardViolation("process blocked: _winapi.CreateProcess")
            pending["approved"] = False
            return
        if event in PROCESS_EVENTS:
            raise GuardViolation(f"process blocked: {event}")

    sys.addaudithook(hook)
    _installed = True


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] != "--run-module":
        print("usage: sandbox_guard.py --run-module MODULE [args...]", file=sys.stderr)
        return 2
    install(allowed_executables=(sys.executable,))
    module = argv[1]
    sys.argv = [module, *argv[2:]]
    runpy.run_module(module, run_name="__main__", alter_sys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
