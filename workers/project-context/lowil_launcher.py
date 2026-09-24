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
import sys
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
INFINITE = 0xFFFFFFFF
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
        "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1", "A2P_ISOLATION": "low-integrity-job",
    }
    for key in ("NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"):
        if key in os.environ:
            values[key] = os.environ[key]
    return "".join(f"{key}={value}\0" for key, value in sorted(values.items(), key=lambda item: item[0].upper())) + "\0"


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


def launch(python: Path, entry: Path, workdir: Path, arguments: list[str], memory_mb: int, max_processes: int, timeout_ms: int = INFINITE) -> int:
    advapi32, kernel32 = _api()
    for folder in (workdir / "home", workdir / "tmp"):
        folder.mkdir(parents=True, exist_ok=True)
    job = _check(kernel32.CreateJobObjectW(None, None), "CreateJobObject")
    limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
    limits.BasicLimitInformation.ActiveProcessLimit = max_processes
    limits.JobMemoryLimit = memory_mb * 1024 * 1024
    _check(kernel32.SetInformationJobObject(job, JOB_EXTENDED_LIMIT_INFORMATION, ctypes.byref(limits), ctypes.sizeof(limits)), "SetInformationJobObject(limits)")
    ui = wintypes.DWORD(UI_RESTRICTIONS)
    _check(kernel32.SetInformationJobObject(job, JOB_BASIC_UI_RESTRICTIONS, ctypes.byref(ui), ctypes.sizeof(ui)), "SetInformationJobObject(ui)")

    token = wintypes.HANDLE()
    _check(advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), TOKEN_ALL_ACCESS, ctypes.byref(token)), "OpenProcessToken")
    low = wintypes.HANDLE()
    _check(advapi32.DuplicateTokenEx(token, TOKEN_ALL_ACCESS, None, SECURITY_IMPERSONATION, TOKEN_PRIMARY, ctypes.byref(low)), "DuplicateTokenEx")
    sid = ctypes.c_void_p()
    _check(advapi32.ConvertStringSidToSidW(LOW_INTEGRITY_SID, ctypes.byref(sid)), "ConvertStringSidToSid")
    label = SID_AND_ATTRIBUTES(sid, SE_GROUP_INTEGRITY)
    _check(advapi32.SetTokenInformation(low, TOKEN_INTEGRITY_LEVEL, ctypes.byref(label), ctypes.sizeof(label) + advapi32.GetLengthSid(sid)), "SetTokenInformation")
    kernel32.LocalFree(sid)
    if integrity_rid(advapi32, low) != LOW_INTEGRITY_RID:
        raise LaunchError("token was not lowered")

    command_line = " ".join(quote(part) for part in [str(python), "-I", str(entry), *arguments])
    startup = STARTUPINFO(cb=ctypes.sizeof(STARTUPINFO))
    process = PROCESS_INFORMATION()
    environment = ctypes.create_unicode_buffer(build_environment(workdir, python))
    _check(advapi32.CreateProcessAsUserW(low, str(python), ctypes.create_unicode_buffer(command_line), None, None, False,
                                         CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, environment, str(workdir),
                                         ctypes.byref(startup), ctypes.byref(process)), "CreateProcessAsUser")
    try:
        if not kernel32.AssignProcessToJobObject(job, process.hProcess):
            kernel32.TerminateProcess(process.hProcess, 90)
            raise LaunchError(f"AssignProcessToJobObject failed ({ctypes.get_last_error()})")
        child_token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(process.hProcess, TOKEN_QUERY, ctypes.byref(child_token)) or integrity_rid(advapi32, child_token) != LOW_INTEGRITY_RID:
            kernel32.TerminateProcess(process.hProcess, 91)
            return 91
        kernel32.CloseHandle(child_token)
        kernel32.ResumeThread(process.hThread)
        kernel32.WaitForSingleObject(process.hProcess, timeout_ms)
        code = wintypes.DWORD()
        kernel32.GetExitCodeProcess(process.hProcess, ctypes.byref(code))
        return code.value
    finally:
        kernel32.CloseHandle(process.hThread)
        kernel32.CloseHandle(process.hProcess)
        kernel32.CloseHandle(low)
        kernel32.CloseHandle(token)
        kernel32.CloseHandle(job)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--entry", required=True, type=Path)
    parser.add_argument("--workdir", required=True, type=Path)
    parser.add_argument("--memory-mb", type=int, default=4096)
    parser.add_argument("--max-processes", type=int, default=8)
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if os.name != "nt":
        print("low-integrity launcher requires Windows", file=sys.stderr)
        return 90
    forwarded = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
    try:
        return launch(args.python.resolve(), args.entry.resolve(), args.workdir.resolve(), forwarded, args.memory_mb, args.max_processes)
    except LaunchError as error:
        print(f"launcher: {error}", file=sys.stderr)
        return 90


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
