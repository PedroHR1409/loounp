"""Isolated project-context worker (contract v1).

Reads a read-only source mount, never writes to it, and publishes results only
into the exchange directory using fixed file names.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

CONTRACT = "v1"
LIMITS = {
    "max_candidate_dirs": 200,
    "max_depth": 12,
    "max_eligible_files": 10_000,
    "max_batch_bytes": 100 * 1024 * 1024,
    "max_file_bytes": 1024 * 1024,
    "project_seconds": 60,
    "batch_seconds": 300,
    "heartbeat_seconds": 5,
    "chunk_chars": 4000,
    "chunk_overlap": 300,
    "max_request_bytes": 1024 * 1024,
}

EXCLUDED_DIRS = {
    ".git", ".svn", ".hg", "node_modules", ".venv", "venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".tox", ".cache", ".next", ".nuxt", ".turbo", ".parcel-cache", "dist", "build", "out", "target",
    "bin", "obj", "coverage", "htmlcov", ".idea", ".vs", ".vscode", "graphify-out", ".terraform", ".gradle",
}
EXCLUDED_NAMES = re.compile(
    r"^(\.env(\..*)?|.*\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx|ppk)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|"
    r"credentials(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|secrets?\..*|.*\.secret|"
    r"package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum)$",
    re.IGNORECASE,
)
DOC_EXTENSIONS = {".md", ".markdown", ".txt", ".rst", ".adoc"}
CODE_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java", ".kt", ".cs", ".c", ".h", ".cpp", ".hpp",
    ".rb", ".php", ".swift", ".scala", ".lua", ".sql", ".sh", ".ps1", ".r", ".jl",
}
CONFIG_EXTENSIONS = {".json", ".toml", ".yaml", ".yml", ".ini", ".cfg"}
MARKERS = re.compile(r"^(readme(\..*)?|package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle|.*\.csproj|.*\.sln|docs)$", re.IGNORECASE)
SECRET_PATTERNS = [
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    re.compile(r"(?i)(api[_-]?key|secret|token|passw(or)?d|client[_-]?secret)\s*[:=]\s*['\"][^'\"\s]{8,}['\"]"),
    re.compile(r"(?i)(password|pwd)=[^;\s]{4,}"),
]
REPARSE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
SYMBOL = re.compile(r"^(export\s+)?(async\s+)?(def|class|function|interface|type|const|fn|func|public|private|protected|struct|impl|module)\b")


class ProtocolError(Exception):
    pass


class UnsafeSource(Exception):
    pass


def is_reparse(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & REPARSE)


def final_path_of_fd(fd: int, fallback: str) -> str:
    if os.name != "nt":
        return os.path.realpath(fallback)
    import ctypes
    import msvcrt
    from ctypes import wintypes

    handle = msvcrt.get_osfhandle(fd)
    func = ctypes.windll.kernel32.GetFinalPathNameByHandleW
    func.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    func.restype = wintypes.DWORD
    buffer = ctypes.create_unicode_buffer(32768)
    length = func(handle, buffer, 32768, 0)
    if not length or length >= 32768:
        raise UnsafeSource("final path unavailable")
    value = buffer.value
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    elif value.startswith("\\\\?\\"):
        value = value[4:]
    return value


def under(child: str, parent: str) -> bool:
    c = os.path.normcase(os.path.normpath(child))
    p = os.path.normcase(os.path.normpath(parent))
    return c == p or c.startswith(p.rstrip("\\/") + os.sep)


def safe_read(root_real: str, path: Path, max_bytes: int) -> tuple[bytes, os.stat_result]:
    before = os.lstat(path)
    if is_reparse(before) or not stat.S_ISREG(before.st_mode):
        raise UnsafeSource("not a regular file")
    if before.st_nlink > 1:
        raise UnsafeSource("hardlinked file")
    if before.st_size > max_bytes:
        raise UnsafeSource("too large")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        if (opened.st_ino, opened.st_dev, opened.st_size) != (before.st_ino, before.st_dev, before.st_size):
            raise UnsafeSource("file changed between validation and open")
        if not under(final_path_of_fd(fd, str(path)), root_real):
            raise UnsafeSource("final path outside source root")
        chunks = []
        remaining = max_bytes + 1
        while remaining > 0:
            data = os.read(fd, min(65536, remaining))
            if not data:
                break
            chunks.append(data)
            remaining -= len(data)
        content = b"".join(chunks)
        if len(content) > max_bytes:
            raise UnsafeSource("too large")
        return content, opened
    finally:
        os.close(fd)


def contains_secret(text: str) -> bool:
    return any(pattern.search(text) for pattern in SECRET_PATTERNS)


def classify(name: str) -> str | None:
    if EXCLUDED_NAMES.match(name):
        return None
    suffix = Path(name).suffix.lower()
    if name.lower().startswith("readme") or suffix in DOC_EXTENSIONS:
        return "doc"
    if suffix in CODE_EXTENSIONS:
        return "code"
    if suffix in CONFIG_EXTENSIONS:
        return "config"
    return None


def chunk_text(text: str, kind: str, size: int = LIMITS["chunk_chars"], overlap: int = LIMITS["chunk_overlap"]) -> list[dict]:
    lines = text.splitlines()
    sections: list[tuple[int, int, str | None]] = []
    start, title = 0, None
    for index, line in enumerate(lines):
        boundary = (kind == "doc" and line.startswith("#")) or (kind == "code" and SYMBOL.match(line))
        if boundary and index > start:
            sections.append((start, index, title))
            start = index
        if boundary:
            title = line.lstrip("#").strip()[:120] or None
    sections.append((start, len(lines), title))
    chunks = []
    for first, last, section in sections:
        cursor = first
        while cursor < last:
            length, end = 0, cursor
            while end < last and (length + len(lines[end]) + 1 <= size or end == cursor):
                length += len(lines[end]) + 1
                end += 1
            body = "\n".join(lines[cursor:end])[:size]
            if body.strip():
                chunks.append({"startLine": cursor + 1, "endLine": end, "section": section, "text": body})
            if end >= last:
                break
            back, carried = end, 0
            while back > cursor + 1 and carried + len(lines[back - 1]) + 1 <= overlap:
                carried += len(lines[back - 1]) + 1
                back -= 1
            cursor = back if back < end else end
    return chunks


@dataclass
class ProjectPlan:
    key: str
    label: str
    relative_root: str
    markers: list[str]
    files: list[tuple[int, Path, str]] = field(default_factory=list)
    excluded: list[dict] = field(default_factory=list)
    truncated: bool = False


def relative(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def walk_project(root: Path, directory: Path, plan: ProjectPlan, depth: int, recurse: bool = True) -> None:
    if depth > LIMITS["max_depth"]:
        plan.truncated = True
        return
    try:
        entries = sorted(os.scandir(directory), key=lambda entry: entry.name.lower())
    except OSError:
        plan.excluded.append({"relativePath": relative(root, directory), "reason": "unreadable_directory"})
        return
    for entry in entries:
        path = Path(entry.path)
        info = entry.stat(follow_symlinks=False)
        if is_reparse(info):
            plan.excluded.append({"relativePath": relative(root, path), "reason": "reparse_point"})
            continue
        if entry.is_dir(follow_symlinks=False):
            if not recurse:
                continue
            if entry.name.lower() in EXCLUDED_DIRS or entry.name.startswith("."):
                plan.excluded.append({"relativePath": relative(root, path), "reason": "excluded_directory"})
                continue
            walk_project(root, path, plan, depth + 1)
            continue
        kind = classify(entry.name)
        if kind is None:
            plan.excluded.append({"relativePath": relative(root, path), "reason": "excluded_or_unsupported"})
            continue
        priority = 0 if entry.name.lower().startswith("readme") else 1 if kind == "doc" else 2 if kind == "code" else 3
        plan.files.append((priority + depth, path, kind))


def plan_projects(root: Path, selected: set[str] | None) -> tuple[list[ProjectPlan], list[str]]:
    plans: list[ProjectPlan] = []
    skipped: list[str] = []
    loose = ProjectPlan("__root__", "(arquivos na raiz)", ".", [])
    candidates = []
    for entry in sorted(os.scandir(root), key=lambda entry: entry.name.lower()):
        info = entry.stat(follow_symlinks=False)
        if is_reparse(info):
            skipped.append(entry.name)
            continue
        if entry.is_dir(follow_symlinks=False):
            if entry.name.lower() in EXCLUDED_DIRS or entry.name.startswith("."):
                continue
            candidates.append(entry)
    for index, entry in enumerate(candidates):
        if index >= LIMITS["max_candidate_dirs"]:
            skipped.append(entry.name)
            continue
        if selected is not None and entry.name not in selected:
            continue
        try:
            markers = sorted(child.name for child in os.scandir(entry.path) if MARKERS.match(child.name))
        except OSError:
            skipped.append(entry.name)
            continue
        if not markers:
            skipped.append(entry.name)
            continue
        plan = ProjectPlan(entry.name, entry.name, entry.name, markers)
        walk_project(root, Path(entry.path), plan, 1)
        plans.append(plan)
    if selected is None or "." in selected:
        walk_project(root, root, loose, 0, recurse=False)
        if loose.files:
            plans.append(loose)
    return plans, skipped


class Publisher:
    def __init__(self, exchange: Path, job_id: str, seq: int):
        self.exchange, self.job_id, self.seq = exchange, job_id, seq
        self.progress = {"phase": "starting"}
        self.lock = threading.Lock()

    def publish(self, name: str, payload: dict) -> None:
        if not re.fullmatch(r"(heartbeat|status|response|project-\d{1,3})\.json", name):
            raise ProtocolError("unexpected output name")
        body = json.dumps({"contract": CONTRACT, "jobId": self.job_id, "seq": self.seq, **payload}, ensure_ascii=False)
        with self.lock:
            fd, temporary = tempfile.mkstemp(dir=self.exchange, prefix=".tmp-", suffix=".json")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(body)
            os.replace(temporary, self.exchange / name)

    def heartbeat_loop(self, stop: threading.Event) -> None:
        while not stop.is_set():
            self.publish("heartbeat.json", {"at": time.time(), "progress": dict(self.progress)})
            stop.wait(LIMITS["heartbeat_seconds"])


def cancel_requested(input_dir: Path, job_id: str) -> bool:
    marker = input_dir / "cancel.json"
    try:
        return json.loads(marker.read_text(encoding="utf-8")).get("jobId") == job_id
    except (OSError, ValueError):
        return False


def catalog(root: Path, params: dict, publisher: Publisher, input_dir: Path, graph_builder) -> dict:
    root_real = os.path.realpath(root)
    if is_reparse(os.lstat(root)):
        raise UnsafeSource("source root is a reparse point")
    selected = set(params["projects"]) if isinstance(params.get("projects"), list) else None
    use_graph = params.get("graph", True) is not False
    plans, skipped = plan_projects(root, selected)
    budget_files, budget_bytes = LIMITS["max_eligible_files"], LIMITS["max_batch_bytes"]
    queues = {plan.key: sorted(plan.files, key=lambda item: (item[0], str(item[1]).lower())) for plan in plans}
    chosen: dict[str, list[tuple[Path, str]]] = {plan.key: [] for plan in plans}
    pending: dict[str, int] = {}
    progressed = True
    while progressed and budget_files > 0 and budget_bytes > 0:
        progressed = False
        for plan in plans:
            queue = queues[plan.key]
            if not queue:
                continue
            _, path, kind = queue.pop(0)
            try:
                size = os.lstat(path).st_size
            except OSError:
                continue
            if size > budget_bytes:
                pending[plan.key] = pending.get(plan.key, 0) + 1
                continue
            chosen[plan.key].append((path, kind))
            budget_files -= 1
            budget_bytes -= min(size, LIMITS["max_file_bytes"])
            progressed = True
    for plan in plans:
        pending[plan.key] = pending.get(plan.key, 0) + len(queues[plan.key])
    started = time.monotonic()
    summaries = []
    for index, plan in enumerate(plans):
        if cancel_requested(input_dir, publisher.job_id):
            return {"state": "canceled", "projects": summaries}
        publisher.progress = {"phase": "catalog", "project": index + 1, "of": len(plans)}
        project_started = time.monotonic()
        files, chunks, excluded = [], [], list(plan.excluded)
        secret_blocked = 0
        copy_dir = Path(tempfile.mkdtemp(prefix="a2p-copy-"))
        try:
            for path, kind in chosen[plan.key]:
                if time.monotonic() - project_started > LIMITS["project_seconds"] or time.monotonic() - started > LIMITS["batch_seconds"]:
                    plan.truncated = True
                    pending[plan.key] += 1
                    continue
                rel = relative(root, path)
                try:
                    content, info = safe_read(root_real, path, LIMITS["max_file_bytes"])
                except UnsafeSource as error:
                    excluded.append({"relativePath": rel, "reason": str(error).replace(" ", "_")})
                    continue
                except OSError:
                    excluded.append({"relativePath": rel, "reason": "unreadable"})
                    continue
                if b"\x00" in content[:8192]:
                    excluded.append({"relativePath": rel, "reason": "binary"})
                    continue
                text = content.decode("utf-8", errors="replace")
                digest = hashlib.sha256(content).hexdigest()
                record = {"relativePath": rel, "identity": f"{info.st_dev}:{info.st_ino}", "bytes": len(content), "sha256": digest, "modifiedAt": info.st_mtime, "kind": kind, "status": "indexed"}
                pieces = chunk_text(text, "doc" if kind == "doc" else "code")
                clean = [piece for piece in pieces if not contains_secret(piece["text"])]
                blocked = len(pieces) - len(clean)
                secret_blocked += blocked
                if blocked:
                    record["status"] = "secret_blocked" if not clean else "indexed"
                    record["blockedChunks"] = blocked
                files.append(record)
                for piece in clean:
                    chunks.append({"relativePath": rel, "sha256": digest, **piece})
                if kind == "code" and not blocked:
                    target = copy_dir / Path(rel)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
            if not use_graph:
                graph = {"status": "disabled", "nodes": [], "edges": []}
            elif any(file["kind"] == "code" for file in files):
                graph = graph_builder(copy_dir, {file["relativePath"] for file in files if file["kind"] == "code"})
            else:
                graph = {"status": "no_code", "nodes": [], "edges": []}
        finally:
            shutil.rmtree(copy_dir, ignore_errors=True)
        output_name = f"project-{index}.json"
        publisher.publish(output_name, {
            "project": {"key": plan.key, "label": plan.label, "relativeRoot": plan.relative_root, "markers": plan.markers},
            "files": files, "chunks": chunks, "excluded": excluded, "graph": graph,
        })
        summaries.append({"key": plan.key, "file": output_name, "indexed": len(files), "excluded": len(excluded), "pending": pending[plan.key], "secretBlockedChunks": secret_blocked, "truncated": plan.truncated})
    partial = any(item["pending"] or item["truncated"] for item in summaries) or bool(skipped)
    return {"state": "partial" if partial else "completed", "projects": summaries, "skippedDirectories": len(skipped)}


def revalidate(root: Path, params: dict) -> dict:
    root_real = os.path.realpath(root)
    results = []
    for item in params.get("files", [])[:200]:
        rel = str(item.get("relativePath", ""))
        candidate = (root / rel)
        if not rel or Path(rel).is_absolute() or ".." in Path(rel).parts or classify(candidate.name) is None:
            results.append({"relativePath": rel, "status": "excluded"})
            continue
        try:
            content, _ = safe_read(root_real, candidate, LIMITS["max_file_bytes"])
        except FileNotFoundError:
            results.append({"relativePath": rel, "status": "missing"})
            continue
        except (UnsafeSource, OSError):
            results.append({"relativePath": rel, "status": "excluded"})
            continue
        digest = hashlib.sha256(content).hexdigest()
        entry = {"relativePath": rel, "sha256": digest, "status": "unchanged" if digest == item.get("sha256") else "changed"}
        ranges = item.get("ranges") or []
        if ranges and entry["status"] == "unchanged":
            lines = content.decode("utf-8", errors="replace").splitlines()
            entry["excerpts"] = [{"startLine": r["startLine"], "endLine": r["endLine"], "text": "\n".join(lines[max(0, r["startLine"] - 1):r["endLine"]])[:LIMITS["chunk_chars"]]} for r in ranges[:10] if isinstance(r, dict) and isinstance(r.get("startLine"), int) and isinstance(r.get("endLine"), int)]
            if any(contains_secret(excerpt["text"]) for excerpt in entry["excerpts"]):
                entry = {"relativePath": rel, "status": "excluded"}
        results.append(entry)
    return {"state": "completed", "files": results}


def load_request(input_dir: Path) -> dict:
    path = input_dir / "request.json"
    info = os.lstat(path)
    if is_reparse(info) or info.st_size > LIMITS["max_request_bytes"]:
        raise ProtocolError("invalid request file")
    request = json.loads(path.read_text(encoding="utf-8"))
    allowed = {"contract", "jobId", "seq", "op", "params"}
    if not isinstance(request, dict) or set(request) - allowed or request.get("contract") != CONTRACT:
        raise ProtocolError("unsupported request")
    if not re.fullmatch(r"job_[A-Za-z0-9_-]{8,64}", str(request.get("jobId"))) or not isinstance(request.get("seq"), int):
        raise ProtocolError("invalid job identity")
    if request.get("op") not in {"catalog", "retrieve", "revalidate", "cancel"}:
        raise ProtocolError("unknown operation")
    if not isinstance(request.get("params", {}), dict):
        raise ProtocolError("invalid params")
    return request


def run(input_dir: Path, exchange: Path, source: Path, graph_builder=None) -> int:
    if graph_builder is None:
        from graphify_adapter import build_graph
        graph_builder = build_graph
    try:
        request = load_request(input_dir)
    except (ProtocolError, OSError, ValueError) as error:
        Publisher(exchange, "job_invalid000", 0).publish("status.json", {"state": "failed", "error": f"request: {error}"})
        return 2
    publisher = Publisher(exchange, request["jobId"], request["seq"])
    stop = threading.Event()
    beat = threading.Thread(target=publisher.heartbeat_loop, args=(stop,), daemon=True)
    beat.start()
    try:
        op, params = request["op"], request.get("params", {})
        if op == "cancel":
            result = {"state": "canceled"}
        elif op == "catalog":
            result = catalog(source, params, publisher, input_dir, graph_builder)
        else:
            result = revalidate(source, params)
        publisher.publish("response.json", result)
        publisher.publish("status.json", {"state": result["state"]})
        return 0
    except Exception as error:  # noqa: BLE001 - every failure must be reported as a closed state
        publisher.publish("status.json", {"state": "failed", "error": type(error).__name__})
        return 1
    finally:
        stop.set()
        beat.join(timeout=2)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--exchange", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from sandbox_guard import install
    install(allowed_executables=(sys.executable,))
    return run(args.input, args.exchange, args.source)


if __name__ == "__main__":
    sys.exit(main())
