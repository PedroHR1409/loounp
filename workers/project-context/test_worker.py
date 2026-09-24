import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker  # noqa: E402

PROTECTED = os.path.normcase(os.path.realpath(os.path.join(os.environ.get("USERPROFILE", ""), "Desktop", "Projetos")))


def no_graph(copy_dir, allowed):
    return {"status": "disabled", "nodes": [], "edges": [], "copied": sorted(p.relative_to(copy_dir).as_posix() for p in copy_dir.rglob("*") if p.is_file())}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="a2p-worker-"))
        self.assertFalse(os.path.normcase(os.path.realpath(self.base)).startswith(PROTECTED), "fixtures must live outside Projetos")
        self.source = self.base / "source"
        self.input = self.base / "input"
        self.exchange = self.base / "exchange"
        for folder in (self.source, self.input, self.exchange):
            folder.mkdir()
        radar = self.source / "radar"
        (radar / "src").mkdir(parents=True)
        (radar / "node_modules" / "lib").mkdir(parents=True)
        (radar / "README.md").write_text("# Radar\n\nRanking explicável sem embeddings.\n\n## Limites\n\nSem busca semântica.\n", encoding="utf-8")
        (radar / "src" / "rank.ts").write_text("export function rank() {\n  return 1\n}\n", encoding="utf-8")
        (radar / ".env").write_text("OPENAI_API_KEY=sk-test-abcdefghijklmnopqrstuvwxyz\n", encoding="utf-8")
        (radar / "config.ts").write_text('const apiKey = "sk-live-abcdefghijklmnopqrstuvwxyz0123"\n', encoding="utf-8")
        (radar / "node_modules" / "lib" / "index.js").write_text("module.exports = 1\n", encoding="utf-8")
        (radar / "logo.png").write_bytes(b"\x89PNG\x00\x00")
        (self.source / "sem-marcador").mkdir()
        (self.source / "sem-marcador" / "notes.py").write_text("x = 1\n", encoding="utf-8")
        (self.source / "ideias.md").write_text("# Ideias soltas\n\nTexto.\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.base, ignore_errors=True)

    def request(self, op, params=None):
        (self.input / "request.json").write_text(json.dumps({"contract": "v1", "jobId": "job_test00001", "seq": 1, "op": op, "params": params or {}}), encoding="utf-8")

    def snapshot(self):
        return {str(p.relative_to(self.source)): (p.stat().st_size, p.stat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None) for p in sorted(self.source.rglob("*"))}

    def read(self, name):
        return json.loads((self.exchange / name).read_text(encoding="utf-8"))


class CatalogTests(Fixture):
    def test_catalog_filters_secrets_and_excluded_paths_without_touching_source(self):
        before = self.snapshot()
        self.request("catalog")
        self.assertEqual(worker.run(self.input, self.exchange, self.source, graph_builder=no_graph), 0)
        self.assertEqual(self.snapshot(), before)
        response = self.read("response.json")
        self.assertEqual(response["jobId"], "job_test00001")
        keys = {project["key"] for project in response["projects"]}
        self.assertEqual(keys, {"radar", "__root__"})
        project = self.read(next(p["file"] for p in response["projects"] if p["key"] == "radar"))
        paths = {f["relativePath"] for f in project["files"]}
        self.assertIn("radar/README.md", paths)
        self.assertIn("radar/src/rank.ts", paths)
        self.assertNotIn("radar/.env", paths)
        dumped = json.dumps(project)
        self.assertNotIn("sk-live", dumped)
        self.assertNotIn("sk-test", dumped)
        self.assertNotIn("node_modules/lib", " ".join(paths))
        self.assertEqual(project["graph"]["copied"], ["radar/src/rank.ts"])
        config = next(f for f in project["files"] if f["relativePath"] == "radar/config.ts")
        self.assertEqual(config["status"], "secret_blocked")
        self.assertEqual(response["skippedDirectories"], 1)
        self.assertEqual(response["state"], "partial")

    def test_graph_can_be_disabled_per_catalog(self):
        self.request("catalog", {"graph": False})
        worker.run(self.input, self.exchange, self.source, graph_builder=lambda *_: self.fail("graph builder must not run"))
        response = self.read("response.json")
        project = self.read(next(p["file"] for p in response["projects"] if p["key"] == "radar"))
        self.assertEqual(project["graph"]["status"], "disabled")

    def test_symlinks_and_hardlinks_are_not_followed(self):
        outside = self.base / "outside.md"
        outside.write_text("# Segredo externo\n", encoding="utf-8")
        radar = self.source / "radar"
        os.link(outside, radar / "hard.md")
        try:
            os.symlink(outside, radar / "link.md")
        except OSError:
            pass
        subprocess.run(["cmd", "/c", "mklink", "/J", str(radar / "junction"), str(self.base)], capture_output=True, check=False)
        self.request("catalog")
        worker.run(self.input, self.exchange, self.source, graph_builder=no_graph)
        response = self.read("response.json")
        project = self.read(next(p["file"] for p in response["projects"] if p["key"] == "radar"))
        self.assertNotIn("Segredo externo", json.dumps(project))
        reasons = {e["relativePath"]: e["reason"] for e in project["excluded"]}
        self.assertEqual(reasons.get("radar/hard.md"), "hardlinked_file")
        if (radar / "junction").exists():
            self.assertEqual(reasons.get("radar/junction"), "reparse_point")

    def test_revalidation_detects_changes_and_returns_excerpts_only_when_unchanged(self):
        readme = self.source / "radar" / "README.md"
        digest = hashlib.sha256(readme.read_bytes()).hexdigest()
        self.request("revalidate", {"files": [
            {"relativePath": "radar/README.md", "sha256": digest, "ranges": [{"startLine": 1, "endLine": 3}]},
            {"relativePath": "radar/missing.md", "sha256": digest},
            {"relativePath": "../outside.md", "sha256": digest},
            {"relativePath": "radar/.env", "sha256": digest},
        ]})
        worker.run(self.input, self.exchange, self.source, graph_builder=no_graph)
        files = {f["relativePath"]: f for f in self.read("response.json")["files"]}
        self.assertEqual(files["radar/README.md"]["status"], "unchanged")
        self.assertIn("Ranking explicável", files["radar/README.md"]["excerpts"][0]["text"])
        self.assertEqual(files["radar/missing.md"]["status"], "missing")
        self.assertEqual(files["../outside.md"]["status"], "excluded")
        self.assertEqual(files["radar/.env"]["status"], "excluded")
        readme.write_text("# Radar\n\nAgora usa embeddings.\n", encoding="utf-8")
        worker.run(self.input, self.exchange, self.source, graph_builder=no_graph)
        changed = self.read("response.json")["files"][0]
        self.assertEqual(changed["status"], "changed")
        self.assertNotIn("excerpts", changed)


class ProtocolTests(Fixture):
    def test_rejects_unknown_fields_and_operations(self):
        (self.input / "request.json").write_text(json.dumps({"contract": "v1", "jobId": "job_test00001", "seq": 1, "op": "shell", "params": {}}), encoding="utf-8")
        self.assertEqual(worker.run(self.input, self.exchange, self.source, graph_builder=no_graph), 2)
        self.assertEqual(self.read("status.json")["state"], "failed")
        (self.input / "request.json").write_text(json.dumps({"contract": "v1", "jobId": "job_test00001", "seq": 1, "op": "catalog", "params": {}, "exec": "calc"}), encoding="utf-8")
        self.assertEqual(worker.run(self.input, self.exchange, self.source, graph_builder=no_graph), 2)

    def test_cancel_marker_stops_catalog(self):
        self.request("catalog")
        (self.input / "cancel.json").write_text(json.dumps({"jobId": "job_test00001"}), encoding="utf-8")
        worker.run(self.input, self.exchange, self.source, graph_builder=no_graph)
        self.assertEqual(self.read("response.json")["state"], "canceled")

    def test_publisher_refuses_arbitrary_output_names(self):
        publisher = worker.Publisher(self.exchange, "job_test00001", 1)
        with self.assertRaises(worker.ProtocolError):
            publisher.publish("..\\..\\evil.json", {})


class ChunkTests(unittest.TestCase):
    def test_markdown_sections_and_size_limits(self):
        text = "# A\n" + "linha longa de texto\n" * 400 + "# B\nfim\n"
        chunks = worker.chunk_text(text, "doc")
        self.assertTrue(all(len(c["text"]) <= worker.LIMITS["chunk_chars"] for c in chunks))
        self.assertEqual(chunks[-1]["section"], "B")
        self.assertEqual(chunks[0]["startLine"], 1)
        self.assertLess(chunks[1]["startLine"], chunks[0]["endLine"] + 1)

    def test_secret_patterns(self):
        self.assertTrue(worker.contains_secret("-----BEGIN RSA PRIVATE KEY-----"))
        self.assertTrue(worker.contains_secret("password=hunter22;"))
        self.assertFalse(worker.contains_secret("Configure a senha no cofre do sistema."))


if __name__ == "__main__":
    unittest.main()
