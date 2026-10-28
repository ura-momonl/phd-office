"""One explicit task through the official SDK. No scheduler or model retry."""
from __future__ import annotations

import json
import os
import sys
from connection import load_connection, connection_options, wire_effort
from datetime import datetime, timezone
from pathlib import Path
from token_usage import summarize_usage, summarize_notifications


def initialize_timeout_seconds() -> float:
    """SDK initialize 窗口，默认 90 秒。2026-10-23 10:29 的召唤失败是冷启动 31.7 秒超过默认 30 秒。"""
    raw = os.environ.get("DSH_INITIALIZE_TIMEOUT_SECONDS", "")
    try:
        value = float(raw)
    except ValueError:
        return 90.0
    return value if value > 0 else 90.0


def execute(task: dict, directory: Path, credentials: dict, harness_class, *, workspace=None, dsh_home=None, patches=None, emit=None, run_session=None) -> dict:
    key = credentials["api_key"]

    def redact(value):
        if isinstance(value, str):
            return value.replace(key, "[REDACTED]") if key else value
        if isinstance(value, dict):
            return {k: redact(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [redact(v) for v in value]
        return value

    result = {"id": task["id"], "status": "failed", "model": task["model"],
              "started_at": datetime.now(timezone.utc).isoformat(), "usage_known": False}
    events = []
    notifications = []

    def notification(n):
        event = redact({"method": n.method, "payload": n.payload})
        notifications.append(event)
        with (directory / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event, ensure_ascii=False) + "\n")
        if emit is not None:
            emit(event)
        if n.method == "session.event" and n.payload.get("sessionId") == task["id"]:
            if isinstance(n.payload.get("event"), dict):
                events.append(n.payload["event"])

    try:
        root = Path(__file__).resolve().parents[2]
        dsh_bin = root / ".runtime/deepseek-harness/npm/node_modules/.bin" / ("dsh.cmd" if os.name == "nt" else "dsh")
        connection, transport_patches = connection_options(root, directory, credentials, task["model"])
        result.update(model=connection["model"], transport=credentials.get("provider", "official"))
        options = {**connection, "dsh_bin": str(dsh_bin),
                   "cwd": str(workspace or directory / "workspace"), "dsh_home": str(dsh_home or directory / "home"),
                   "profile": "sdk",
                   "max_tokens": task["max_tokens"],
                   "initialize_timeout_seconds": initialize_timeout_seconds(),
                   "patches": (patches or (str(Path(__file__).with_name("delegate.patch.yml")),)) + transport_patches}
        if "reasoning_effort" in task:
            options["reasoning_effort"] = wire_effort(credentials, task["reasoning_effort"])
        with harness_class(**options) as harness:
            answer = (run_session(harness, task, notification) if run_session else
                      harness.run(task["prompt"], session_id=task["id"], on_notification=notification))
        result.update(final_response=redact(answer.final_response), finish_reason=answer.finish_reason)
        result["max_tokens"] = task.get("max_tokens")
        if answer.finish_reason == "completed" and answer.final_response.strip():
            result["status"] = "completed"
        elif answer.finish_reason == "max-tokens":
            # 输出上限（推理也算）用尽：此时工具调用可能只写了一半，不能当完成。
            result["error"] = (f"输出被截断：这次回复用尽 {task.get('max_tokens')} tokens 的单次输出上限（含推理），"
                               "任务没有交出完整结果；提高 max_tokens 或把这一步拆小后重发")
        else:
            result["error"] = f"Task did not complete: {answer.finish_reason}"
            for event in reversed(events):
                if event.get("type") == "turn/end":
                    detail = event.get("data", {}).get("reason", {}).get("error", {})
                    if isinstance(detail, dict) and isinstance(detail.get("message"), str):
                        result["error"] = redact(detail["message"])
                    break
    except BaseException as error:
        message = f"{type(error).__name__}: {error}"
        if isinstance(error, TimeoutError) and "initialize timed out" in str(error):
            # 此时还没有向模型发出请求，也没有产生费用。
            message = "DeepSeek 运行时没能在初始化窗口内完成启动；这条没有答成，重发一次通常就好"
        result["error"] = redact(message)
    result.update(summarize_notifications(notifications, task["id"], completed=result["status"] == "completed"))
    result["finished_at"] = datetime.now(timezone.utc).isoformat()
    return result


def main() -> int:
    if os.environ.get("PHD_ISOLATED_TESTS") == "1":
        raise RuntimeError("Real DeepSeek calls disabled in isolated tests")
    task_file = Path(sys.argv[1]).resolve()
    task = json.loads(task_file.read_text(encoding="utf-8-sig"))
    directory = task_file.parent
    root = Path(__file__).resolve().parents[2]
    try:
        credentials = load_connection(root)
        # The official full SDK profile owns tools, policy, persistence and lifecycle.
        from deepseek_harness import DeepSeekHarness
        result = execute(task, directory, credentials, DeepSeekHarness)
    except Exception as error:
        result = {"id": task["id"], "status": "failed", "usage_known": False,
                  "error": f"Local preparation failed: {type(error).__name__}"}
    (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
