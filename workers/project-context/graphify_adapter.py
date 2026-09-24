"""Graphify adapter: code-only extraction over a filtered disposable copy."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

ADAPTER_VERSION = "graphify-adapter-v1"
MAX_NODES = 50_000
MAX_EDGES = 100_000
MAX_GRAPH_BYTES = 64 * 1024 * 1024
TIMEOUT_SECONDS = 60
GUARD = Path(__file__).with_name("sandbox_guard.py")
PASSTHROUGH_ENV = ("SYSTEMROOT", "WINDIR", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE")


def _clean_env(home: Path) -> dict[str, str]:
    env = {key: os.environ[key] for key in PASSTHROUGH_ENV if key in os.environ}
    env.update({
        "PATH": str(Path(sys.executable).parent),
        "GRAPHIFY_OUT": "graphify-out",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "0",
        "HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(home), "LOCALAPPDATA": str(home),
        "XDG_CONFIG_HOME": str(home), "XDG_CACHE_HOME": str(home), "TEMP": str(home), "TMP": str(home),
    })
    return env


def _relative_source(value: object, copy_root: Path, allowed: set[str]) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    candidate = Path(value)
    if candidate.is_absolute():
        try:
            candidate = candidate.resolve().relative_to(copy_root.resolve())
        except (ValueError, OSError):
            return None
    posix = PurePosixPath(candidate.as_posix())
    if ".." in posix.parts:
        return None
    text = str(posix)
    return text if text in allowed else None


def _node_id(relative_path: str | None, label: str, raw_id: str) -> str:
    return "gn_" + hashlib.sha256(f"{relative_path}|{label}|{raw_id}".encode("utf-8")).hexdigest()[:24]


def normalize(raw: dict, copy_root: Path, allowed: set[str]) -> dict:
    nodes_in = raw.get("nodes") if isinstance(raw, dict) else None
    edges_in = raw.get("links", raw.get("edges")) if isinstance(raw, dict) else None
    if not isinstance(nodes_in, list) or not isinstance(edges_in, list):
        return {"status": "invalid_output", "nodes": [], "edges": [], "adapter": ADAPTER_VERSION}
    truncated = len(nodes_in) > MAX_NODES or len(edges_in) > MAX_EDGES
    mapping: dict[str, str] = {}
    nodes = []
    for node in nodes_in[:MAX_NODES]:
        if not isinstance(node, dict) or "id" not in node:
            continue
        rel = _relative_source(node.get("source_file"), copy_root, allowed)
        label = str(node.get("label", ""))[:200]
        own = _node_id(rel, label, str(node["id"]))
        mapping[str(node["id"])] = own
        location = node.get("source_location")
        nodes.append({"id": own, "label": label, "relativePath": rel, "location": str(location)[:40] if location else None})
    edges = []
    for edge in edges_in[:MAX_EDGES]:
        if not isinstance(edge, dict):
            continue
        source, target = mapping.get(str(edge.get("source"))), mapping.get(str(edge.get("target")))
        if source and target:
            edges.append({"source": source, "target": target, "relation": str(edge.get("relation", "related"))[:60]})
    return {"status": "partial" if truncated else "ok", "nodes": nodes, "edges": edges, "adapter": ADAPTER_VERSION}


def build_graph(copy_root: Path, allowed: set[str]) -> dict:
    with tempfile.TemporaryDirectory(prefix="a2p-graph-") as scratch:
        out_root = Path(scratch) / "out"
        home = Path(scratch) / "home"
        out_root.mkdir()
        home.mkdir()
        command = [sys.executable, "-I", str(GUARD), "--run-module", "graphify", "extract", ".", "--code-only", "--no-cluster", "--no-dedup", "--max-workers", "1", "--out", str(out_root)]
        try:
            completed = subprocess.run(command, cwd=copy_root, env=_clean_env(home), capture_output=True, text=True, timeout=TIMEOUT_SECONDS, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return {"status": "timeout", "nodes": [], "edges": [], "adapter": ADAPTER_VERSION}
        except OSError:
            return {"status": "unavailable", "nodes": [], "edges": [], "adapter": ADAPTER_VERSION}
        if completed.returncode != 0:
            missing = "No module named graphify" in completed.stderr
            return {"status": "unavailable" if missing else "failed", "nodes": [], "edges": [], "adapter": ADAPTER_VERSION}
        graph_path = out_root / "graphify-out" / "graph.json"
        try:
            info = os.lstat(graph_path)
        except OSError:
            return {"status": "failed", "nodes": [], "edges": [], "adapter": ADAPTER_VERSION}
        if info.st_size > MAX_GRAPH_BYTES:
            return {"status": "too_large", "nodes": [], "edges": [], "adapter": ADAPTER_VERSION}
        try:
            raw = json.loads(graph_path.read_text(encoding="utf-8"))
        except ValueError:
            return {"status": "invalid_output", "nodes": [], "edges": [], "adapter": ADAPTER_VERSION}
        return normalize(raw, copy_root, allowed)
