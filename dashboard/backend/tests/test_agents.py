import time
import unittest
from unittest import mock

from app import agents as a


_TMP = None


def setUpModule():
    global _TMP
    import tempfile
    from pathlib import Path
    _TMP = tempfile.TemporaryDirectory()
    root = Path(_TMP.name)
    for name, path in (("HIST", root), ("AUDIT", root / "audit.jsonl"), ("USAGE", root / "usage.jsonl")):
        mock.patch.object(a, name, path).start()


def tearDownModule():
    mock.patch.stopall()
    _TMP.cleanup()


def script(*items):
    it = iter(items)
    return lambda cfg, system, transcript, tools: next(it)


def wait(chat):
    for _ in range(100):
        if chat.status not in ("running", "stopping"):
            return
        time.sleep(0.02)


class Loop(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        a.CHATS.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.p1 = mock.patch.object(a, "HIST", Path(self.tmp.name)); self.p1.start()
        self.p2 = mock.patch.object(a, "AUDIT", Path(self.tmp.name) / "audit.jsonl"); self.p2.start()

    def tearDown(self):
        self.p1.stop(); self.p2.stop(); self.tmp.cleanup()

    def test_read_runs_change_waits_then_declined(self):
        llm = script(
            {"role": "assistant", "text": "", "calls": [{"id": "1", "name": "list_stacks", "input": {}},
                                                       {"id": "2", "name": "run_action", "input": {"stack": "ai-ran-bsr", "action": "deploy"}}]},
            {"role": "assistant", "text": "ok, not deploying", "calls": []})
        with mock.patch.object(a, "complete", llm), mock.patch.object(a, "load_cfg", lambda: {"provider": "x", "model": "m"}), \
             mock.patch.dict(a.TOOLS, {"list_stacks": (lambda _: ["s"], "", {}), "run_action": (lambda *_: self.fail("ran"), "", {})}):
            chat = a.chat_of("u", "deploy")
            chat.items.append({"role": "user", "text": "deploy bsr"})
            a._start(chat); wait(chat)
            self.assertEqual(chat.status, "approval")
            self.assertEqual([p["name"] for p in chat.pending], ["run_action"])
            self.assertEqual(chat.items[-1]["result"], '["s"]')
            a.agent_decide("deploy", {"approve": {"2": False}}, "u"); wait(chat)
            self.assertEqual(chat.status, "idle")
            self.assertTrue(any(i.get("result") == "the operator declined this action" for i in chat.items))
            self.assertEqual(chat.items[-1]["text"], "ok, not deploying")
            self.assertEqual([c["title"] for c in a.agent_history("deploy", "u")["conversations"]], ["deploy bsr"])
            outcomes = [__import__("json").loads(l)["outcome"] for l in open(a.AUDIT)]
            self.assertEqual(outcomes, ["ran", "declined"])
            a.CHATS.clear()
            self.assertEqual(a.chat_of("u", "deploy").id, chat.id)

    def test_secrets_are_not_readable(self):
        out, err = a._execute("read_file", {"path": str(a.SECRETS / "password")}, "u")
        self.assertTrue(err and "not a file under" in out)


if __name__ == "__main__":
    unittest.main()


class Stop(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        a.CHATS.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.p = [mock.patch.object(a, "HIST", Path(self.tmp.name)), mock.patch.object(a, "AUDIT", Path(self.tmp.name) / "a.jsonl")]
        for p in self.p:
            p.start()

    def tearDown(self):
        for p in self.p:
            p.stop()
        self.tmp.cleanup()

    def test_stop_mid_run_leaves_a_valid_transcript(self):
        chat = a.chat_of("u", "deploy")
        def press_stop(_):
            a.agent_stop("deploy", "u")
            return ["s"]
        llm = script({"role": "assistant", "text": "", "calls": [{"id": "1", "name": "list_stacks", "input": {}},
                                                                {"id": "2", "name": "stack_status", "input": {"stack": "x"}}]})
        with mock.patch.object(a, "complete", llm), mock.patch.object(a, "load_cfg", lambda: {"provider": "x", "model": "m"}), \
             mock.patch.dict(a.TOOLS, {"list_stacks": (press_stop, "", {}), "stack_status": (lambda _: self.fail("ran after Stop"), "", {})}):
            chat.items.append({"role": "user", "text": "go"})
            a._start(chat); wait(chat)
        self.assertEqual(chat.status, "idle")
        self.assertEqual(chat.items[-1]["text"], "Stopped.")
        answered = {it["id"] for it in chat.items if it["role"] == "tool"}
        self.assertEqual(answered, {"1", "2"})

    def test_stop_while_llm_hangs_is_immediate(self):
        import threading
        chat, release = a.chat_of("u", "deploy"), threading.Event()
        def slow(*_):
            release.wait(5)
            return {"role": "assistant", "text": "late answer", "calls": []}
        with mock.patch.object(a, "complete", slow), mock.patch.object(a, "load_cfg", lambda: {"provider": "x", "model": "m"}):
            chat.items.append({"role": "user", "text": "go"})
            a._start(chat)
            while not chat.in_llm:
                pass
            a.agent_stop("deploy", "u")
            self.assertEqual(chat.status, "idle")
            self.assertEqual(chat.items[-1]["text"], "Stopped.")
            release.set(); time.sleep(0.2)
        self.assertNotIn("late answer", [it.get("text") for it in chat.items])


class Guard(unittest.TestCase):
    def chat(self, agent, items):
        c = a.Chat.__new__(a.Chat)
        c.agent, c.items = agent, items
        return c

    def call(self, act, cid="x"):
        return {"id": cid, "name": "run_action", "input": {"stack": "s", "action": act}}

    def ran(self, act, cid):
        return [{"role": "assistant", "text": "", "calls": [self.call(act, cid)]}, {"role": "tool", "id": cid, "result": "{}"}]

    def test_ml_agent_cannot_deploy_to_inspect_data(self):
        c = self.chat("ml", [{"role": "user", "text": "train se_ml on these CSVs"}])
        self.assertIn("run_python", a._guard(c, self.call("deploy")))
        self.assertIn("train_model", a._guard(c, self.call("train")))
        self.assertIsNone(a._guard(c, self.call("check")))

    def test_ml_agent_may_deploy_after_a_code_change_or_when_asked(self):
        w = [{"role": "assistant", "text": "", "calls": [{"id": "w", "name": "write_file", "input": {}}]}, {"role": "tool", "id": "w", "result": "ok"}]
        self.assertIsNone(a._guard(self.chat("ml", [{"role": "user", "text": "go"}, *w]), self.call("build")))
        self.assertIsNone(a._guard(self.chat("ml", [{"role": "user", "text": "now deploy it"}]), self.call("deploy")))

    def test_repeating_without_change_pauses(self):
        items = [{"role": "user", "text": "deploy it"}, *self.ran("deploy", "1"), *self.ran("stop", "2"), *self.ran("deploy", "3")]
        why = a._guard(self.chat("deploy", items), self.call("deploy"))
        self.assertTrue(why and why.startswith(a.CHURN))
        fixed = [*items, {"role": "assistant", "text": "", "calls": [{"id": "w", "name": "write_file", "input": {}}]}, {"role": "tool", "id": "w", "result": "ok"}]
        self.assertIsNone(a._guard(self.chat("deploy", fixed), self.call("deploy")))

    def test_approve_returns_at_once_and_stop_ends_a_slow_tool(self):
        chat = a.chat_of("u", "ml")
        def slow(_a, _u):
            while not chat.stop.is_set():
                time.sleep(0.01)
            return "killed"
        llm = script({"role": "assistant", "text": "", "calls": [{"id": "1", "name": "run_python", "input": {"stack": "s", "code": "x"}}]})
        with mock.patch.object(a, "complete", llm), mock.patch.object(a, "load_cfg", lambda: {"provider": "x", "model": "m"}), \
             mock.patch.dict(a.TOOLS, {"run_python": (slow, "", {})}):
            chat.items.append({"role": "user", "text": "go"})
            a._start(chat); wait(chat)
            self.assertEqual(chat.status, "approval")
            t0 = time.time()
            a.agent_decide("ml", {"approve": {"1": True}}, "u")
            self.assertLess(time.time() - t0, 0.5)
            self.assertEqual((chat.status, chat.pending), ("running", []))
            a.agent_stop("ml", "u"); wait(chat)
        self.assertEqual(chat.status, "idle")
        self.assertEqual(chat.items[-1]["text"], "Stopped.")


class Compact(unittest.TestCase):
    def test_old_items_shrink_new_ones_stay_whole(self):
        big = "x" * 20000
        items = [{"role": "user", "text": big}]
        for n in range(12):
            items += [{"role": "assistant", "text": "", "calls": [{"id": str(n), "name": "run_python", "input": {"code": big}}], "raw": [1]},
                      {"role": "tool", "id": str(n), "result": big}]
        out = a._compact(items)
        self.assertEqual(out[0]["text"], big)
        self.assertLess(len(out[1]["calls"][0]["input"]["code"]), 2000)
        self.assertLess(len(out[2]["result"]), 2000)
        self.assertEqual(out[-1]["result"], big)
        self.assertIsNone(out[1]["raw"])
        self.assertEqual(len(items[2]["result"]), 20000)


class EditAndStreak(unittest.TestCase):
    def test_edit_file_replaces_one_exact_match(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as t, mock.patch.object(a, "WRITE_ROOTS", (Path(t),)), mock.patch.object(a.d, "VAR", Path(t)):
            f = Path(t) / "x.py"
            f.write_text("a = 1\nb = 2\nb = 2\n")
            a.t_edit_file({"path": str(f), "old": "a = 1", "new": "a = 3"}, "u")
            self.assertEqual(f.read_text(), "a = 3\nb = 2\nb = 2\n")
            with self.assertRaises(ValueError):
                a.t_edit_file({"path": str(f), "old": "b = 2", "new": "b = 9"}, "u")

    def test_five_failed_runs_in_a_row_pause(self):
        items = [{"role": "user", "text": "train it"}]
        for n in range(5):
            items += [{"role": "assistant", "text": "", "calls": [{"id": str(n), "name": "run_python", "input": {}}]},
                      {"role": "tool", "id": str(n), "name": "run_python", "result": "ran on master; exit 1. ...\nTraceback"}]
        c = a.Chat.__new__(a.Chat)
        c.agent, c.items = "ml", items
        call = {"id": "z", "name": "run_python", "input": {}}
        self.assertTrue(a._guard(c, call).startswith(a.CHURN))
        c.items = items[:-2] + [items[-2], {**items[-1], "result": "ran on master; exit 0. ok"}]
        self.assertIsNone(a._guard(c, call))


class AutoAndUsage(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        a.CHATS.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.p = [mock.patch.object(a, "HIST", Path(self.tmp.name)), mock.patch.object(a, "AUDIT", Path(self.tmp.name) / "a.jsonl"),
                  mock.patch.object(a, "USAGE", Path(self.tmp.name) / "u.jsonl")]
        for p in self.p:
            p.start()

    def tearDown(self):
        for p in self.p:
            p.stop()
        self.tmp.cleanup()
        a.CHATS.clear()

    def test_auto_runs_changes_without_asking_and_counts_tokens(self):
        chat = a.chat_of("u", "ml")
        a.agent_auto("ml", {"on": True}, "u")
        ran = []
        llm = script({"role": "assistant", "text": "", "calls": [{"id": "1", "name": "save_settings", "input": {"stack": "s", "changes": {}}}],
                      "usage": {"in": 1000, "out": 50, "cached": 800}},
                     {"role": "assistant", "text": "done", "calls": [], "usage": {"in": 1200, "out": 20, "cached": 1000}})
        with mock.patch.object(a, "complete", llm), mock.patch.object(a, "load_cfg", lambda: {"provider": "x", "model": "m"}), \
             mock.patch.dict(a.TOOLS, {"save_settings": (lambda i, u: ran.append(i) or "ok", "", {})}):
            chat.items.append({"role": "user", "text": "go"})
            a._start(chat); wait(chat)
        self.assertEqual((chat.status, len(ran)), ("idle", 1))
        u = a._usage(chat.items)
        self.assertEqual((u["calls"], u["in"], u["out"], u["last_in"]), (2, 2200, 70, 1200))
        self.assertIn("auto-approved", (a.AUDIT).read_text())
        self.assertEqual(len(a.USAGE.read_text().splitlines()), 2)
