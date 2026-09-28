"""Application-level guard: refuses network and unapproved process creation.

This is a defense-in-depth layer installed with sys.addaudithook; it cannot be
removed once installed. The write barrier itself comes from the low-integrity
token applied by lowil_launcher.py, not from this module.
"""
from __future__ import annotations

import os
import runpy
import subprocess
import sys
import tempfile
from pathlib import Path

NETWORK_EVENTS = {"socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg"}
PROCESS_EVENTS = {
    "subprocess.Popen", "os.system", "os.exec", "os.spawn", "os.fork",
    "os.forkpty", "os.posix_spawn", "os.startfile", "_winapi.CreateProcess",
}
GRAPHIFY_ENV_KEYS = {
    "SYSTEMROOT",
    "WINDIR",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PATH",
    "GRAPHIFY_OUT",
    "PYTHONNOUSERSITE",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONHASHSEED",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "TEMP",
    "TMP",
}
GRAPHIFY_PREFIX = (
    "--run-module",
    "graphify",
    "extract",
)
GRAPHIFY_FLAGS = (
    "--code-only",
    "--no-cluster",
    "--no-dedup",
    "--max-workers",
    "1",
    "--out",
)

_installed = False
_allow_graphify = False
_pending = {
    "graphify": False,
    "graphify_argv": None,
    "graphify_commandline": None,
    "graphify_cwd": None,
    "graphify_env": None,
    "create_process": False,
}


class GuardViolation(RuntimeError):
    pass


def _normalize(path: object) -> str:
    if not isinstance(path, (str, bytes, os.PathLike)):
        return ""
    return os.path.normcase(os.path.abspath(os.fsdecode(path)))


def _is_inside(path: Path, root: Path) -> bool:
    try:
        common = os.path.commonpath((str(path), str(root)))
        return os.path.normcase(common) == os.path.normcase(str(root))
    except (OSError, ValueError):
        return False


def _is_graphify_invocation(args: tuple) -> bool:
    if len(args) < 4:
        return False
    executable, command, cwd, env = args[:4]
    if executable is not None and _normalize(executable) != _normalize(sys.executable):
        return False
    if (
        not isinstance(command, (list, tuple))
        or len(command) != len(GRAPHIFY_PREFIX) + len(GRAPHIFY_FLAGS) + 5
        or any(not isinstance(value, str) for value in command)
    ):
        return False
    if _normalize(command[0]) != _normalize(sys.executable):
        return False
    if _normalize(command[2]) != _normalize(Path(__file__).resolve()):
        return False
    if command[1] != "-I" or tuple(command[3:6]) != GRAPHIFY_PREFIX:
        return False
    if _normalize(command[6]) != _normalize(cwd):
        return False
    if tuple(command[7:-1]) != GRAPHIFY_FLAGS:
        return False
    if not isinstance(env, dict) or set(env) - GRAPHIFY_ENV_KEYS:
        return False
    if not isinstance(cwd, (str, bytes, os.PathLike)):
        return False

    try:
        temp_root = Path(tempfile.gettempdir()).resolve()
        raw_workdir = Path(os.fsdecode(cwd))
        raw_output = Path(command[-1])
        if not raw_workdir.is_absolute() or not raw_output.is_absolute():
            return False
        workdir = raw_workdir.resolve()
        output = raw_output.resolve()
        scratch = output.parent
    except (OSError, RuntimeError, ValueError):
        return False
    return (
        not raw_workdir.is_symlink()
        and not raw_output.is_symlink()
        and not scratch.is_symlink()
        and workdir.is_dir()
        and _is_inside(workdir, temp_root)
        and output.name == "out"
        and scratch.name.startswith("a2p-graph-")
        and scratch.is_dir()
        and output.is_dir()
        and _is_inside(scratch, temp_root)
    )


def run_graphify_subprocess(command: list[str], **options):
    """Run only the fixed Graphify extraction command from its disposable copy."""
    if options.get("shell", False):
        raise GuardViolation("process blocked: shell execution is disabled")
    if not _is_graphify_invocation((None, command, options.get("cwd"), options.get("env"))):
        raise GuardViolation("process blocked: command is not the fixed Graphify invocation")
    if _installed and not _allow_graphify:
        raise GuardViolation("process blocked: Graphify child processes are disabled")

    _pending["graphify"] = _installed
    _pending["graphify_argv"] = tuple(command)
    _pending["graphify_commandline"] = subprocess.list2cmdline(command) if os.name == "nt" else None
    _pending["graphify_cwd"] = _normalize(options.get("cwd"))
    _pending["graphify_env"] = dict(options["env"])
    try:
        return subprocess.run(command, **options)
    finally:
        _pending["graphify"] = False
        _pending["graphify_argv"] = None
        _pending["graphify_commandline"] = None
        _pending["graphify_cwd"] = None
        _pending["graphify_env"] = None
        _pending["create_process"] = False


def install(*, allow_graphify: bool = False) -> None:
    global _allow_graphify, _installed
    if _installed:
        return
    _allow_graphify = allow_graphify

    def hook(event: str, args: tuple) -> None:
        if event in NETWORK_EVENTS:
            raise GuardViolation(f"network blocked: {event}")
        if event == "subprocess.Popen":
            executable, command, cwd, env = args
            command_matches = (
                command == _pending["graphify_commandline"]
                if isinstance(command, str)
                else isinstance(command, (list, tuple))
                and tuple(command) == _pending["graphify_argv"]
            )
            executable_matches = executable is None or _normalize(executable) == _normalize(sys.executable)
            audit_args = (
                executable,
                _pending["graphify_argv"] if isinstance(command, str) else command,
                cwd,
                env,
            )
            invocation_matches = (
                _allow_graphify
                and _pending["graphify"]
                and command_matches
                and executable_matches
                and _normalize(cwd) == _pending["graphify_cwd"]
                and env == _pending["graphify_env"]
                and _is_graphify_invocation(audit_args)
            )
            if not invocation_matches:
                raise GuardViolation("process blocked: subprocess.Popen")
            _pending["graphify"] = False
            _pending["create_process"] = True
            return
        if event == "_winapi.CreateProcess":
            if not _pending["create_process"]:
                raise GuardViolation("process blocked: _winapi.CreateProcess")
            _pending["create_process"] = False
            return
        if event in PROCESS_EVENTS:
            raise GuardViolation(f"process blocked: {event}")

    sys.addaudithook(hook)
    _installed = True


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] != "--run-module":
        print("usage: sandbox_guard.py --run-module MODULE [args...]", file=sys.stderr)
        return 2
    install()
    module = argv[1]
    if module == "graphify" and os.name == "nt":
        # Python 3.14's platform.system() shells out to `ver` on Windows.
        # Graphify only needs the OS name here, and child processes stay blocked.
        import platform

        platform.system = lambda: "Windows"
    sys.argv = [module, *argv[2:]]
    runpy.run_module(module, run_name="__main__", alter_sys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
