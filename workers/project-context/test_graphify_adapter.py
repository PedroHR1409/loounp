import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import graphify_adapter  # noqa: E402


class NormalizeTests(unittest.TestCase):
    def setUp(self):
        self.copy = Path(tempfile.mkdtemp(prefix="a2p-graph-test-"))

    def test_maps_nodes_to_own_ids_and_drops_untrusted_paths(self):
        raw = {"nodes": [
            {"id": "rank", "label": "rank()", "source_file": "radar/src/rank.ts", "source_location": "L1"},
            {"id": "abs", "label": "evil", "source_file": r"C:\Windows\system32\x.py"},
            {"id": "up", "label": "up", "source_file": "../../outside.py"},
            {"id": "inside", "label": "inside", "source_file": str(self.copy / "radar" / "src" / "rank.ts")},
        ], "links": [{"source": "rank", "target": "inside", "relation": "calls"}, {"source": "rank", "target": "ghost"}]}
        graph = graphify_adapter.normalize(raw, self.copy, {"radar/src/rank.ts"})
        self.assertEqual(graph["status"], "ok")
        paths = [node["relativePath"] for node in graph["nodes"]]
        self.assertEqual(paths, ["radar/src/rank.ts", None, None, "radar/src/rank.ts"])
        self.assertTrue(all(node["id"].startswith("gn_") for node in graph["nodes"]))
        self.assertEqual(len(graph["edges"]), 1)
        self.assertEqual(graph["edges"][0]["relation"], "calls")

    def test_truncation_is_reported_as_partial(self):
        with mock.patch.object(graphify_adapter, "MAX_NODES", 1):
            graph = graphify_adapter.normalize({"nodes": [{"id": "a"}, {"id": "b"}], "links": []}, self.copy, set())
        self.assertEqual(graph["status"], "partial")
        self.assertEqual(len(graph["nodes"]), 1)

    def test_invalid_shapes(self):
        self.assertEqual(graphify_adapter.normalize({"nodes": "x"}, self.copy, set())["status"], "invalid_output")

    def test_clean_env_drops_credentials(self):
        with mock.patch.dict("os.environ", {"OPENAI_API_KEY": "sk-x", "GITHUB_TOKEN": "t", "SYSTEMROOT": r"C:\Windows"}):
            env = graphify_adapter._clean_env(self.copy)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("GITHUB_TOKEN", env)
        self.assertEqual(env["USERPROFILE"], str(self.copy))
        self.assertEqual(env["PYTHONHASHSEED"], "0")

    def test_missing_graphify_degrades_to_unavailable(self):
        (self.copy / "a.py").write_text("def a():\n    return 1\n", encoding="utf-8")
        result = graphify_adapter.build_graph(self.copy, {"a.py"})
        self.assertIn(result["status"], {"unavailable", "ok"})


if __name__ == "__main__":
    unittest.main()
