"""Host-side launcher: runs an entry script at low integrity inside a Job Object.

Runs at the user's normal (medium) integrity, needs no administrator rights,
and never executes content from the consulted projects. The child cannot write
to medium-integrity objects (the user's files); it can only write to
low-integrity locations such as AppData\\LocalLow.
Exit codes: child's exit code, 90 setup failure, 91 child not at low integrity.
"""
from __future__ import annotations

import argparse
import ctypes
import os
import stat
import subprocess
import sys
import uuid
from ctypes import wintypes
from pathlib import Path

LOW_INTEGRITY_SID = "S-1-16-4096"
LOW_INTEGRITY_RID = 0x1000
TOKEN_ALL_ACCESS = 0xF01FF
TOKEN_QUERY = 0x0008
SECURITY_IMPERSONATION = 2
TOKEN_PRIMARY = 1
TOKEN_INTEGRITY_LEVEL = 25
SE_GROUP_INTEGRITY = 0x20
CREATE_SUSPENDED = 0x4
CREATE_NO_WINDOW = 0x08000000
CREATE_UNICODE_ENVIRONMENT = 0x400
CREATE_EXTENDED_STARTUPINFO_PRESENT = 0x00080000
INFINITE = 0xFFFFFFFF
PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
TOKEN_IS_APP_CONTAINER = 29
JOB_EXTENDED_LIMIT_INFORMATION = 9
JOB_BASIC_UI_RESTRICTIONS = 4
JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200
JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
UI_RESTRICTIONS = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40 | 0x80


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong), ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION), ("IoInfo", IO_COUNTERS), ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]


class STARTUPINFO(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR), ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
                ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD), ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
                ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD), ("dwFillAttribute", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
                ("lpReserved2", ctypes.c_void_p), ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE)]


class STARTUPINFOEX(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFO), ("lpAttributeList", ctypes.c_void_p)]


class SECURITY_CAPABILITIES(ctypes.Structure):
    _fields_ = [("AppContainerSid", ctypes.c_void_p), ("Capabilities", ctypes.c_void_p),
                ("CapabilityCount", wintypes.DWORD), ("Reserved", wintypes.DWORD)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE), ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]


class LaunchError(Exception):
    pass


def _api():
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)]
    kernel32.InitializeProcThreadAttributeList.restype = wintypes.BOOL
    kernel32.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p,
                                                   ctypes.c_size_t, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t)]
    kernel32.UpdateProcThreadAttribute.restype = wintypes.BOOL
    kernel32.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.DuplicateTokenEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.ConvertStringSidToSidW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
    advapi32.SetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi32.GetLengthSid.argtypes = [ctypes.c_void_p]
    advapi32.GetSidSubAuthorityCount.argtypes = [ctypes.c_void_p]
    advapi32.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
    advapi32.GetSidSubAuthority.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    advapi32.GetSidSubAuthority.restype = ctypes.POINTER(wintypes.DWORD)
    advapi32.FreeSid.argtypes = [ctypes.c_void_p]
    advapi32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    advapi32.CreateProcessAsUserW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL,
                                              wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p]
    return advapi32, kernel32


def _check(result, what: str):
    if not result:
        raise LaunchError(f"{what} failed ({ctypes.get_last_error()})")
    return result


def integrity_rid(advapi32, token) -> int:
    size = wintypes.DWORD()
    advapi32.GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, None, 0, ctypes.byref(size))
    buffer = ctypes.create_string_buffer(size.value)
    _check(advapi32.GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, buffer, size, ctypes.byref(size)), "GetTokenInformation")
    label = ctypes.cast(buffer, ctypes.POINTER(SID_AND_ATTRIBUTES)).contents
    count = advapi32.GetSidSubAuthorityCount(label.Sid).contents.value
    return advapi32.GetSidSubAuthority(label.Sid, count - 1).contents.value


def build_environment(workdir: Path, python: Path) -> str:
    system_root = os.environ.get("SYSTEMROOT", r"C:\Windows")
    home = workdir / "home"
    temp = workdir / "tmp"
    values = {
        "SYSTEMROOT": system_root, "WINDIR": os.environ.get("WINDIR", system_root),
        "PATH": os.pathsep.join([str(python.parent), str(Path(system_root) / "System32")]),
        "TEMP": str(temp), "TMP": str(temp), "HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(home), "LOCALAPPDATA": str(home),
        "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1", "A2P_ISOLATION": "low-integrity-appcontainer-no-network",
        "A2P_GRAPH_SCRATCH": str(workdir / "a2p-graph-job"),
    }
    for key in ("NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"):
        if key in os.environ:
            values[key] = os.environ[key]
    return "".join(f"{key}={value}\0" for key, value in sorted(values.items(), key=lambda item: item[0].upper())) + "\0"


def _checked_path(path: Path) -> tuple[Path, bool]:
    try:
        raw = Path(os.path.abspath(path))
        for component in (raw, *raw.parents):
            try:
                info = component.lstat()
            except OSError:
                continue
            if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise LaunchError(f"reparse point refused for sandbox resource: {component}")
        full = raw.resolve(strict=True)
        info = full.stat()
    except OSError as error:
        raise LaunchError(f"sandbox resource is unavailable: {path}") from error
    if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise LaunchError(f"reparse point refused for sandbox resource: {path}")
    return full, stat.S_ISDIR(info.st_mode)


class AppContainerAcl:
    """Temporarily grants one fresh, networkless AppContainer access to its job inputs."""

    def __init__(self, sid: str):
        self.sid = sid
        self.paths: list[tuple[Path, bool]] = []
        self.icacls = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32" / "icacls.exe"

    def grant(self, path: Path, access: str, *, recursive: bool = False) -> None:
        full, is_directory = _checked_path(path)
        flags = "(OI)(CI)" if is_directory else ""
        self.paths.append((full, recursive))
        traversal = ["/T", "/L", "/C"] if recursive else []
        result = subprocess.run(
            [str(self.icacls), str(full), "/grant", f"*{self.sid}:{flags}({access})", *traversal, "/Q"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if result.returncode:
            raise LaunchError(f"could not grant AppContainer access to {full} ({result.returncode})")

    def cleanup(self) -> None:
        failures = []
        for path, recursive in reversed(self.paths):
            traversal = ["/T", "/L", "/C"] if recursive else []
            result = subprocess.run(
                [str(self.icacls), str(path), "/remove:g", f"*{self.sid}", *traversal, "/Q"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            if result.returncode:
                details = (result.stderr or result.stdout).strip()
                failures.append(f"{path} ({result.returncode}): {details}")
        self.paths.clear()
        if failures:
            raise LaunchError("could not remove temporary AppContainer ACLs: " + ", ".join(failures))


def _create_profile(userenv, name: str) -> tuple[str, ctypes.c_void_p]:
    sid = ctypes.c_void_p()
    create = userenv.CreateAppContainerProfile
    create.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                       ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    create.restype = ctypes.c_long
    result = create(name, "Loounp project worker", "Temporary networkless project discovery job", None, 0, ctypes.byref(sid))
    if result < 0 or not sid.value:
        raise LaunchError(f"CreateAppContainerProfile failed (0x{result & 0xffffffff:08x})")
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    text_sid = wintypes.LPWSTR()
    _check(advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text_sid)), "ConvertSidToStringSid")
    value = text_sid.value
    ctypes.WinDLL("kernel32", use_last_error=True).LocalFree(ctypes.cast(text_sid, ctypes.c_void_p))
    return value, sid


def _delete_profile(userenv, name: str) -> None:
    delete = userenv.DeleteAppContainerProfile
    delete.argtypes = [wintypes.LPCWSTR]
    delete.restype = ctypes.c_long
    result = delete(name)
    if result < 0:
        raise LaunchError(f"DeleteAppContainerProfile failed (0x{result & 0xffffffff:08x})")


def _grant_job_paths(acl: AppContainerAcl, python: Path, entry: Path, workdir: Path,
                     read_paths: list[Path], write_paths: list[Path]) -> None:
    resolved_python = python.resolve()
    runtime_root = (
        resolved_python.parent.parent.parent
        if resolved_python.parent.name.lower() == "scripts"
        and resolved_python.parent.parent.name.lower() == "venv"
        else resolved_python.parent
    )
    read_acl_paths = [
        path
        for path in (entry.parent, *read_paths)
        if not path.resolve().is_relative_to(runtime_root)
    ]
    for path in read_acl_paths:
        acl.grant(path, "RX", recursive=True)
    graph_scratch = workdir / "a2p-graph-job"
    for path in (
        workdir,
        workdir / "home",
        workdir / "tmp",
        workdir / "copy",
        graph_scratch,
        graph_scratch / "out",
        graph_scratch / "out" / "graphify-out",
        graph_scratch / "home",
        *write_paths,
    ):
        acl.grant(path, "M")


def quote(argument: str) -> str:
    if argument and not any(char in argument for char in ' \t"'):
        return argument
    escaped, backslashes = [], 0
    for char in argument:
        if char == "\\":
            backslashes += 1
            continue
        if char == '"':
            escaped.append("\\" * (backslashes * 2 + 1) + '"')
        else:
            escaped.append("\\" * backslashes + char)
        backslashes = 0
    escaped.append("\\" * (backslashes * 2))
    return '"' + "".join(escaped) + '"'


def launch_appcontainer(python: Path, entry: Path, workdir: Path, arguments: list[str], memory_mb: int,
                       max_processes: int, read_paths: list[Path], write_paths: list[Path],
                       timeout_ms: int = INFINITE) -> int:
    advapi32, kernel32 = _api()
    userenv = ctypes.WinDLL("userenv", use_last_error=True)
    graph_scratch = workdir / "a2p-graph-job"
    for folder in (
        workdir / "home",
        workdir / "tmp",
        workdir / "copy",
        graph_scratch / "out" / "graphify-out",
        graph_scratch / "home",
    ):
        folder.mkdir(parents=True, exist_ok=True)

    app_name = "Loounp.Job." + uuid.uuid4().hex
    app_sid = ctypes.c_void_p()
    acl = None
    job = token = low = None
    process = PROCESS_INFORMATION()
    attribute_list = ctypes.create_string_buffer(1)
    attribute_list_ready = False
    try:
        sid_text, app_sid = _create_profile(userenv, app_name)
        acl = AppContainerAcl(sid_text)
        _grant_job_paths(acl, python, entry, workdir, read_paths, write_paths)

        job = _check(kernel32.CreateJobObjectW(None, None), "CreateJobObject")
        limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = (
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
        )
        limits.BasicLimitInformation.ActiveProcessLimit = max_processes
        limits.JobMemoryLimit = memory_mb * 1024 * 1024
        _check(
            kernel32.SetInformationJobObject(
                job,
                JOB_EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(limits),
                ctypes.sizeof(limits),
            ),
            "SetInformationJobObject(limits)",
        )
        ui = wintypes.DWORD(UI_RESTRICTIONS)
        _check(
            kernel32.SetInformationJobObject(
                job, JOB_BASIC_UI_RESTRICTIONS, ctypes.byref(ui), ctypes.sizeof(ui)
            ),
            "SetInformationJobObject(ui)",
        )

        token = wintypes.HANDLE()
        _check(
            advapi32.OpenProcessToken(
                kernel32.GetCurrentProcess(), TOKEN_ALL_ACCESS, ctypes.byref(token)
            ),
            "OpenProcessToken",
        )
        low = wintypes.HANDLE()
        _check(
            advapi32.DuplicateTokenEx(
                token,
                TOKEN_ALL_ACCESS,
                None,
                SECURITY_IMPERSONATION,
                TOKEN_PRIMARY,
                ctypes.byref(low),
            ),
            "DuplicateTokenEx",
        )
        integrity_sid = ctypes.c_void_p()
        _check(
            advapi32.ConvertStringSidToSidW(
                LOW_INTEGRITY_SID, ctypes.byref(integrity_sid)
            ),
            "ConvertStringSidToSid",
        )
        label = SID_AND_ATTRIBUTES(integrity_sid, SE_GROUP_INTEGRITY)
        _check(
            advapi32.SetTokenInformation(
                low,
                TOKEN_INTEGRITY_LEVEL,
                ctypes.byref(label),
                ctypes.sizeof(label) + advapi32.GetLengthSid(integrity_sid),
            ),
            "SetTokenInformation",
        )
        kernel32.LocalFree(integrity_sid)
        if integrity_rid(advapi32, low) != LOW_INTEGRITY_RID:
            raise LaunchError("token was not lowered")

        required = ctypes.c_size_t()
        kernel32.InitializeProcThreadAttributeList(
            None, 1, 0, ctypes.byref(required)
        )
        attribute_list = ctypes.create_string_buffer(required.value)
        _check(
            kernel32.InitializeProcThreadAttributeList(
                attribute_list, 1, 0, ctypes.byref(required)
            ),
            "InitializeProcThreadAttributeList",
        )
        attribute_list_ready = True
        capabilities = SECURITY_CAPABILITIES(app_sid, None, 0, 0)
        _check(
            kernel32.UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                ctypes.byref(capabilities),
                ctypes.sizeof(capabilities),
                None,
                None,
            ),
            "UpdateProcThreadAttribute(SECURITY_CAPABILITIES)",
        )
        startup = STARTUPINFOEX(
            STARTUPINFO(cb=ctypes.sizeof(STARTUPINFOEX)),
            ctypes.cast(attribute_list, ctypes.c_void_p),
        )
        command_line = " ".join(
            quote(part) for part in [str(python), "-I", str(entry), *arguments]
        )
        environment = ctypes.create_unicode_buffer(build_environment(workdir, python))
        _check(
            advapi32.CreateProcessAsUserW(
                low,
                str(python),
                ctypes.create_unicode_buffer(command_line),
                None,
                None,
                False,
                CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_EXTENDED_STARTUPINFO_PRESENT,
                environment,
                str(workdir),
                ctypes.byref(startup),
                ctypes.byref(process),
            ),
            "CreateProcessAsUser(AppContainer)",
        )
        kernel32.DeleteProcThreadAttributeList(attribute_list)
        attribute_list_ready = False

        if not kernel32.AssignProcessToJobObject(job, process.hProcess):
            kernel32.TerminateProcess(process.hProcess, 90)
            raise LaunchError(
                f"AssignProcessToJobObject failed ({ctypes.get_last_error()})"
            )
        child_token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(
            process.hProcess, TOKEN_QUERY, ctypes.byref(child_token)
        ):
            kernel32.TerminateProcess(process.hProcess, 91)
            raise LaunchError("could not inspect child token")
        app_container = wintypes.DWORD()
        size = wintypes.DWORD()
        is_container = advapi32.GetTokenInformation(
            child_token,
            TOKEN_IS_APP_CONTAINER,
            ctypes.byref(app_container),
            ctypes.sizeof(app_container),
            ctypes.byref(size),
        )
        child_integrity = integrity_rid(advapi32, child_token)
        kernel32.CloseHandle(child_token)
        if not is_container or not app_container.value or child_integrity != LOW_INTEGRITY_RID:
            kernel32.TerminateProcess(process.hProcess, 91)
            raise LaunchError("child is missing the low-integrity AppContainer token")

        _check(kernel32.ResumeThread(process.hThread), "ResumeThread")
        wait_result = kernel32.WaitForSingleObject(process.hProcess, timeout_ms)
        if wait_result != 0:
            kernel32.TerminateProcess(process.hProcess, 92)
            raise LaunchError(f"worker wait failed or timed out ({wait_result})")
        code = wintypes.DWORD()
        _check(
            kernel32.GetExitCodeProcess(process.hProcess, ctypes.byref(code)),
            "GetExitCodeProcess",
        )
        return code.value
    finally:
        if attribute_list_ready:
            kernel32.DeleteProcThreadAttributeList(attribute_list)
        if process.hThread:
            kernel32.CloseHandle(process.hThread)
        if process.hProcess:
            kernel32.CloseHandle(process.hProcess)
        if low:
            kernel32.CloseHandle(low)
        if token:
            kernel32.CloseHandle(token)
        if job:
            kernel32.CloseHandle(job)
        try:
            if acl:
                acl.cleanup()
        finally:
            if app_sid:
                advapi32.FreeSid(app_sid)
                _delete_profile(userenv, app_name)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--entry", required=True, type=Path)
    parser.add_argument("--workdir", required=True, type=Path)
    parser.add_argument("--memory-mb", type=int, default=4096)
    parser.add_argument("--max-processes", type=int, default=8)
    parser.add_argument("--read-path", action="append", type=Path, default=[])
    parser.add_argument("--write-path", action="append", type=Path, default=[])
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if os.name != "nt":
        print("low-integrity launcher requires Windows", file=sys.stderr)
        return 90
    forwarded = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
    try:
        return launch_appcontainer(
            args.python.resolve(),
            args.entry.resolve(),
            args.workdir.resolve(),
            forwarded,
            args.memory_mb,
            args.max_processes,
            args.read_path,
            args.write_path,
        )
    except LaunchError as error:
        print(f"launcher: {error}", file=sys.stderr)
        return 90


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
