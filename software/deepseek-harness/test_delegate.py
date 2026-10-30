import importlib.util
import json
import os
import shutil
import unittest
import uuid
import io
import queue
import threading
import subprocess
from unittest.mock import patch
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from connection import load_connection, connection_options, wire_effort

spec = importlib.util.spec_from_file_location("office_delegate", Path(__file__).with_name("delegate.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

live_spec = importlib.util.spec_from_file_location("office_live", Path(__file__).with_name("live.py"))
live = importlib.util.module_from_spec(live_spec)
live_spec.loader.exec_module(live)

TEST_TMP = Path(__file__).resolve().parents[2] / ".runtime" / "tmp"


@contextmanager
def temporary_directory():
    """普通 mkdir 目录，继承工作区 ACL；mkdtemp 的 0700 目录在沙箱下写不进去。"""
    path = TEST_TMP / ("delegate-test-" + uuid.uuid4().hex)
    path.mkdir(parents=True)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


class DelegationTests(unittest.TestCase):
    def test_v41_flash_declares_image_input_for_native_read_image(self):
        credentials = {"provider": "commandcode", "api_key": "fixture-secret",
                       "base_url": "https://api.commandcode.ai/provider/v1"}
        with temporary_directory() as directory:
            for model in ("deepseek-flash", "deepseek-v4-flash", "deepseek-flash-fast",
                          "deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash-fast"):
                with self.subTest(model=model):
                    _, patches = connection_options(directory, directory, credentials, model)
                    profile = json.loads(Path(patches[0]).read_text(encoding="utf-8"))[0]["config"]["providers"]["office-commandcode"]
                    self.assertEqual(profile["models"][0]["input"], ["text", "image"])
            for model in ("deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-fast", "deepseek/deepseek-v4-pro"):
                with self.subTest(model=model):
                    _, patches = connection_options(directory, directory, credentials, model)
                    profile = json.loads(Path(patches[0]).read_text(encoding="utf-8"))[0]["config"]["providers"]["office-commandcode"]
                    self.assertEqual(profile["models"][0]["input"], ["text"])

    def test_commandcode_uses_existing_native_adapter_and_never_puts_key_in_patch(self):
        with temporary_directory() as directory:
            credentials = {"provider": "commandcode", "api_key": "fixture-commandcode-private",
                           "base_url": "https://api.commandcode.ai/provider/v1"}
            options, patches = connection_options(directory, directory, credentials, "deepseek-flash")
            self.assertEqual(options["provider"], "office-commandcode")
            self.assertEqual(options["model"], "deepseek/deepseek-v4.1-flash")
            self.assertEqual(options["env"]["OFFICE_COMMANDCODE_API_KEY"], credentials["api_key"])
            self.assertEqual(options["env"]["NODE_OPTIONS"], "--network-family-autoselection-attempt-timeout=1500")
            patch = Path(patches[0]).read_text(encoding="utf-8")
            self.assertNotIn(credentials["api_key"], patch)
            entries = json.loads(patch)
            self.assertEqual(entries[0]["id"], "llm-pi-ai")
            self.assertNotIn("insert", entries[0])
            profile = entries[0]["config"]["providers"]["office-commandcode"]
            self.assertEqual(profile["retryPolicy"], {"mode": "normal", "maxRetries": 3,
                                                      "backoff": {"initialDelayMs": 1000, "maxDelayMs": 10000}})
            self.assertEqual(profile["models"][0]["reasoningEfforts"], {"off": None, "minimal": "off", "low": "low", "high": "high", "max": "max"})
            # Office "off" must reach Command Code as reasoning_effort "off" (via the spare level); other levels and the official API are untouched.
            self.assertEqual(wire_effort(credentials, "off"), "minimal")
            self.assertEqual(wire_effort(credentials, "high"), "high")
            self.assertEqual(wire_effort({"provider": "official"}, "off"), "off")
            for field, value in (("provider", "unknown"), ("base_url", "https://evil.example")):
                with self.assertRaises(ValueError):
                    connection_options(directory, directory, {**credentials, field: value}, "deepseek-flash")
            with self.assertRaises(ValueError):
                connection_options(directory, directory, credentials, "unrelated-model")
            fast, _ = connection_options(directory, directory, credentials, "deepseek-flash-fast")
            self.assertEqual(fast["model"], "deepseek/deepseek-v4.1-flash-fast")
            official = {"provider": "official", "api_key": "official-fixture", "base_url": "https://api.deepseek.com/anthropic"}
            self.assertEqual(connection_options(directory, directory, official, "deepseek-flash")[0]["model"], "deepseek-flash")
            self.assertNotIn("env", connection_options(directory, directory, official, "deepseek-flash")[0])
            with self.assertRaises(ValueError):
                connection_options(directory, directory, official, "deepseek-flash-fast")

    def test_commandcode_child_node_gets_connection_attempt_budget_without_disabling_ipv6(self):
        with temporary_directory() as directory:
            options, _ = connection_options(directory, directory,
                {"provider": "commandcode", "api_key": "fixture-secret",
                 "base_url": "https://api.commandcode.ai/provider/v1"}, "deepseek-flash")
            result = subprocess.run(["node", "-e",
                "const n=require('net');console.log(JSON.stringify({enabled:n.getDefaultAutoSelectFamily(),ms:n.getDefaultAutoSelectFamilyAttemptTimeout()}))"],
                env={**os.environ, **options["env"]}, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout), {"enabled": True, "ms": 1500})

    def test_transport_selection_has_no_implicit_fallback_and_preserves_official_credentials(self):
        with temporary_directory() as directory:
            official = directory / ".runtime/deepseek-harness/credentials.json"
            official.parent.mkdir(parents=True)
            original = '{"api_key":"official-fixture","base_url":"https://api.deepseek.com/anthropic"}'
            official.write_text(original, encoding="utf-8")
            self.assertEqual(load_connection(directory)["provider"], "official")
            selection = official.with_name("provider.json")
            selection.write_text('{"provider":"commandcode"}', encoding="utf-8")
            with self.assertRaises(FileNotFoundError):
                load_connection(directory)
            commandcode = directory / ".runtime/commandcode/credentials.json"
            commandcode.parent.mkdir(parents=True)
            commandcode.write_text('\ufeff{"api_key":"commandcode-fixture","base_url":"https://api.commandcode.ai/provider/v1"}', encoding="utf-8")
            self.assertEqual(load_connection(directory)["api_key"], "commandcode-fixture")
            self.assertEqual(official.read_text(encoding="utf-8"), original)

    def exercise(self, reason="completed", text="中文结果", error=None):
        captured = {}

        class Harness:
            def __init__(self, **options):
                captured.update(options)

            def __enter__(self):
                return self

            def __exit__(self, *_):
                captured["closed"] = True

            def run(self, prompt, session_id, on_notification):
                captured["prompt"] = prompt
                captured["session"] = session_id
                on_notification(SimpleNamespace(method="session.event", payload={
                    "sessionId": session_id, "event": {"type": "tool/call", "data": {"text": "fixture-secret"}}}))
                if error:
                    raise RuntimeError(error)
                return SimpleNamespace(finish_reason=reason, final_response=text)

        task = {"id": "fixture-job", "model": "fixture-model", "max_tokens": 512, "prompt": "完整中文任务"}
        with temporary_directory() as temp:
            directory = Path(temp)
            result = module.execute(task, directory, {"api_key": "fixture-secret", "base_url": "https://example.invalid"}, Harness)
            trace = (directory / "events.jsonl").read_text(encoding="utf-8")
            self.assertNotIn("fixture-secret", trace)
            self.assertIn("[REDACTED]", trace)
            self.assertEqual(captured["prompt"], task["prompt"])
            self.assertEqual(captured["cwd"], str(directory / "workspace"))
            self.assertEqual(captured["dsh_home"], str(directory / "home"))
            self.assertEqual(captured["profile"], "sdk")
            self.assertTrue(captured["closed"])
            self.assertEqual(result["tool_calls"], 1)
            self.assertFalse(result["usage_known"])
            return result

    def test_completed_result(self):
        result = self.exercise()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["final_response"], "中文结果")

    def test_truncated_or_unknown_finish_is_not_success(self):
        for reason in ("max-tokens", "error", None):
            with self.subTest(reason=reason):
                self.assertEqual(self.exercise(reason=reason)["status"], "failed")

    def test_empty_result_is_not_success(self):
        self.assertEqual(self.exercise(text=" ")["status"], "failed")

    def test_max_tokens_failure_names_the_output_limit(self):
        result = self.exercise(reason="max-tokens")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["max_tokens"], 512)
        self.assertIn("输出被截断", result["error"])
        self.assertIn("512", result["error"])

    def test_error_redacted_and_not_retried(self):
        result = self.exercise(error="failed using fixture-secret")
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("fixture-secret", json.dumps(result))

    def test_initialize_timeout_defaults_to_90_seconds_and_is_overridable(self):
        self.assertEqual(module.initialize_timeout_seconds(), 90.0)
        os.environ["DSH_INITIALIZE_TIMEOUT_SECONDS"] = "45"
        try:
            self.assertEqual(module.initialize_timeout_seconds(), 45.0)
        finally:
            del os.environ["DSH_INITIALIZE_TIMEOUT_SECONDS"]
        for bad in ("", "0", "-5", "abc"):
            os.environ["DSH_INITIALIZE_TIMEOUT_SECONDS"] = bad
            try:
                self.assertEqual(module.initialize_timeout_seconds(), 90.0)
            finally:
                del os.environ["DSH_INITIALIZE_TIMEOUT_SECONDS"]

    def test_harness_receives_initialize_timeout(self):
        captured = {}

        class Harness:
            def __init__(self, **options):
                captured.update(options)

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def run(self, *_args, **_kwargs):
                return SimpleNamespace(finish_reason="completed", final_response="ok")

        with temporary_directory() as temp:
            module.execute({"id": "timeout-job", "model": "fixture-model", "max_tokens": 512, "prompt": "任务"},
                           Path(temp), {"api_key": "fixture-secret", "base_url": "https://example.invalid"}, Harness)
        self.assertEqual(captured["initialize_timeout_seconds"], 90.0)

    def test_initialize_timeout_reports_plain_failure_without_retry(self):
        starts = []

        class Harness:
            def __init__(self, **options):
                pass

            def __enter__(self):
                starts.append(1)
                raise TimeoutError("initialize timed out waiting for DeepSeek Harness runtime\nselected dsh profile 'sdk'")

            def __exit__(self, *_):
                return False

            def run(self, *_args, **_kwargs):
                raise AssertionError("初始化失败时不应向模型发出请求")

        with temporary_directory() as temp:
            result = module.execute({"id": "timeout-job", "model": "fixture-model", "max_tokens": 512, "prompt": "任务"},
                                    Path(temp), {"api_key": "fixture-secret", "base_url": "https://example.invalid"}, Harness)
        self.assertEqual(len(starts), 1)
        self.assertEqual(result["status"], "failed")
        self.assertIn("初始化窗口", result["error"])

    def test_usage_includes_cache_once_and_never_invents_unknown_values(self):
        events = [{"type": "assistant/message", "data": {"usage": {
            "inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 20, "cacheWriteTokens": 3}}}]
        known, usage = module.summarize_usage(events)
        self.assertTrue(known)
        self.assertEqual(usage, {"input_tokens": 33, "cached_input_tokens": 20, "cache_creation_tokens": 3, "output_tokens": 5})
        for extra in ({"type": "assistant/attempt"}, {"type": "compaction/end"},
                      {"type": "assistant/message", "data": {}},
                      {"type": "assistant/message", "data": {"usage": {"inputTokens": -1, "outputTokens": 0}}}):
            self.assertFalse(module.summarize_usage(events + [extra])[0])
        self.assertFalse(module.summarize_usage([])[0])

    def test_token_totals_follow_descendants_not_other_invocations_and_deduplicate_replays(self):
        def message(sid, seq, direct, cached, output):
            return {"method": "session.event", "payload": {"sessionId": sid, "event": {
                "type": "assistant/message", "seq": seq, "data": {"usage": {
                    "inputTokens": direct, "cacheReadTokens": cached, "outputTokens": output}}}}}
        def started(parent, child):
            return {"method": "subagent.started", "payload": {"parentSessionId": parent, "childSessionId": child}}
        def finished(parent, child):
            return {"method": "subagent.finished", "payload": {"parentSessionId": parent,
                "childSessionId": child, "status": "ok", "stopReason": "completed"}}
        events = [message("root", 1, 675, 117248, 222), message("child", 1, 10, 20, 5),
                  message("grandchild", 1, 2, 3, 4), started("child", "grandchild"), started("root", "child"),
                  message("other-office-invocation", 1, 9999999, 0, 9999999),
                  finished("child", "grandchild"), finished("root", "child")]
        # The natural root message reports totalTokens=118145. It is not a
        # cumulative counter: cache+direct+output must reconstruct that number.
        result = module.summarize_notifications(events + [events[0]], "root")
        self.assertTrue(result["usage_known"])
        self.assertFalse(result["usage_partial"])
        self.assertEqual(result["usage"], {"input_tokens": 117958, "cached_input_tokens": 117271,
            "cache_creation_tokens": 0, "output_tokens": 231})
        partial = module.summarize_notifications(events, "root", completed=False)
        self.assertFalse(partial["usage_known"])
        self.assertTrue(partial["usage_partial"])
        self.assertEqual(partial["usage"], result["usage"])
        missing = module.summarize_notifications(events + [started("root", "no-usage")], "root")
        self.assertTrue(missing["usage_partial"])
        self.assertEqual(missing["usage"], result["usage"])
        self.assertIsNone(module.summarize_notifications([], "root")["usage"])
        attempted = {"method": "session.event", "payload": {"sessionId": "root", "event": {
            "type": "assistant/attempt", "seq": 5}}}
        self.assertTrue(module.summarize_notifications(events + [attempted], "root")["usage_partial"])

    def test_execute_preserves_observed_tokens_on_model_failure_and_includes_child_tokens(self):
        class Harness:
            def __init__(self, **options):
                pass
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def run(self, prompt, session_id, on_notification):
                for sid in (session_id, "fish"):
                    if sid == "fish":
                        on_notification(SimpleNamespace(method="subagent.started", payload={
                            "parentSessionId": session_id, "childSessionId": sid}))
                    on_notification(SimpleNamespace(method="session.event", payload={"sessionId": sid,
                        "event": {"type": "assistant/message", "seq": 1, "data": {"usage": {
                            "inputTokens": 10, "cacheReadTokens": 20, "outputTokens": 5}}}}))
                raise RuntimeError("fixture stream failed")
        with temporary_directory() as temp:
            result = module.execute({"id": "failed-root", "model": "fixture-model", "max_tokens": 512, "prompt": "task"},
                Path(temp), {"api_key": "fixture-secret", "base_url": "https://example.invalid"}, Harness)
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["usage_known"])
        self.assertTrue(result["usage_partial"])
        self.assertEqual(result["usage"]["input_tokens"], 60)
        self.assertEqual(result["usage"]["output_tokens"], 10)

    def test_chat_uses_office_workspace_and_streams_only_redacted_notifications(self):
        captured = {}
        streamed = []

        class Harness:
            def __init__(self, **options):
                captured.update(options)

            def __enter__(self):
                return self

            def __exit__(self, *_):
                captured["closed"] = True

            def run(self, prompt, session_id, on_notification):
                on_notification(SimpleNamespace(method="session.event", payload={"sessionId": session_id,
                                "event": {"type": "tool/call", "data": {"text": "fixture-secret"}}}))
                return SimpleNamespace(finish_reason="completed", final_response="正式同事")

        with temporary_directory() as temp:
            directory = Path(temp)
            workspace = directory / "office"
            result = module.execute({"id": "chat-job", "model": "fixture", "prompt": "完整历史", "max_tokens": 512},
                                    directory, {"api_key": "fixture-secret", "base_url": "https://example.invalid"},
                                    Harness, workspace=workspace, dsh_home=directory / "user-global-home",
                                    patches=("chat.patch.yml", "ask.patch.yml"), emit=streamed.append)
            self.assertEqual(captured["cwd"], str(workspace))
            self.assertEqual(captured["dsh_home"], str(directory / "user-global-home"))
            self.assertEqual(captured["patches"], ("chat.patch.yml", "ask.patch.yml"))
            self.assertTrue(captured["closed"])
            self.assertEqual(result["final_response"], "正式同事")
            self.assertNotIn("fixture-secret", json.dumps(streamed))
            self.assertIn("[REDACTED]", json.dumps(streamed))

    def test_chat_patch_reuses_exact_desktop_whitelist_and_ask_does_not_load_it(self):
        import sys
        with patch.dict(sys.modules, {"delegate": module, "live": live}):
            spec = importlib.util.spec_from_file_location("office_chat", Path(__file__).with_name("chat.py"))
            chat = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(chat)
        with temporary_directory() as temp:
            root = Path(temp)
            config = root / "software/computer-use/mcp.json"
            config.parent.mkdir(parents=True)
            server = {"command": "fixture.exe", "args": ["--tools", "Snapshot,Screenshot"], "env": {"ANONYMIZED_TELEMETRY": "false"}}
            config.write_text(json.dumps({"mcpServers": {"windows-mcp": server}}), encoding="utf-8")
            system = root / "prompts/office-system.md"
            system.parent.mkdir()
            system.write_text("共享办公室提示词\n- 中文与 Unicode “不变”。\n", encoding="utf-8")
            ask = chat.chat_patches(root, root, "ask")
            self.assertEqual(len(ask), 3)
            self.assertTrue(ask[-1].endswith("ask.patch.yml"))
            persona = json.loads(Path(ask[1]).read_text(encoding="utf-8"))
            self.assertEqual(persona, [{"id": "system-prompt", "config": {"personaPrefix": system.read_text(encoding="utf-8").rstrip()}}])
            self.assertFalse((root / "deepseek-mcp.patch.json").exists())
            system.write_text("改动来源后下一轮直接生效。\n", encoding="utf-8")
            work = chat.chat_patches(root, root, "work")
            self.assertEqual(json.loads(Path(work[1]).read_text(encoding="utf-8"))[0]["config"]["personaPrefix"], "改动来源后下一轮直接生效。")
            row = json.loads(Path(work[-1]).read_text(encoding="utf-8"))[0]["insert"][0]
            self.assertTrue(row["name"].endswith("dsh-mcp-client/lib/index.js"))
            for key, value in server.items():
                self.assertEqual(row["config"][key], value)
            self.assertFalse(row["config"]["reconnect"]["enabled"])
            self.assertTrue(row["config"]["failOnStartupError"])
            maintenance = json.loads(Path(work[-1]).read_text(encoding="utf-8"))[0]["insert"][1]
            self.assertEqual(maintenance["id"], "office-memory-maintenance")
            self.assertTrue(maintenance["name"].endswith("software/deepseek-harness/memory-tool.mjs"))
            self.assertEqual(maintenance["config"], {"runDirectory": str(root)})

    def test_live_inputs_do_not_wait_for_previous_response_and_receipts_belong_to_native_inbox(self):
        import sys
        from types import ModuleType
        api = ModuleType("deepseek_harness.api")
        api.final_response = lambda events: next(e["data"]["message"]["content"][0]["text"] for e in reversed(events) if e["type"] == "assistant/message")
        api.finish_reason = lambda events: next(e["data"]["reason"]["kind"] for e in reversed(events) if e["type"] == "turn/end")
        native, second_sent, calls, observed = queue.Queue(), threading.Event(), [], []

        def event(kind, data):
            return SimpleNamespace(method="session.event", payload={"sessionId": "fixture", "event": {"type": kind, "data": data}})

        class Subscription:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def next(self): return native.get(timeout=5)

        class Client:
            def subscribe_session_notifications(self, session_id): return Subscription()
            def session_prompt(self, session_id, blocks, **_):
                text = blocks[0]["text"]
                calls.append(text)
                message_id = "native-" + text
                native.put(event("agent/inbox/spliced", {"inserted": [{"id": message_id}]}))
                if text == "第一条":
                    self_waited = second_sent.wait(3)
                    if not self_waited: raise RuntimeError("Second input was blocked by first response")
                if text == "第二条":
                    second_sent.set()
                    native.put(event("assistant/message", {"message": {"content": [{"type": "text", "text": "收到两条中文补充"}]}}))
                    native.put(event("turn/end", {"reason": {"kind": "completed"}}))
                    native.put(SimpleNamespace(method="session.status", payload={"sessionId": "fixture", "status": "idle"}))
                return message_id

        source = io.StringIO('\n'.join(json.dumps({"id": str(i), "text": text}, ensure_ascii=False) for i, text in enumerate(["第一条", "第二条"])) + '\n')
        with patch.dict(sys.modules, {"deepseek_harness.api": api}):
            result = live.run_interactive(SimpleNamespace(client=Client()), {"id": "fixture", "prompt": "初始"}, observed.append, source=source)
        self.assertEqual(calls[0], "初始")
        self.assertCountEqual(calls[1:], ["第一条", "第二条"])
        self.assertEqual(result.final_response, "收到两条中文补充")
        receipts = [n.payload for n in observed if n.method == "office.input"]
        self.assertEqual(len(receipts), 2)
        self.assertTrue(all(r["accepted"] for r in receipts))
        self.assertEqual(result.finish_reason, "completed")


if __name__ == "__main__":
    unittest.main()
