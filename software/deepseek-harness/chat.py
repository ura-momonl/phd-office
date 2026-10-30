"""Office chat uses the same official SDK, with the office as its workspace.

Every invocation is fresh; the controller supplies the full conversation. The
explicit delegation entry retains its separate workspace and profile overlay.
"""
import json
import os
import sys
from pathlib import Path
from delegate import execute
from live import run_interactive
from connection import load_connection


def chat_patches(root, directory, mode):
    # All three colleagues consume the same office text; the patch is a run artifact,
    # not a second editable copy. Keep the native work/ask configuration unchanged.
    persona = directory / "office-system.patch.json"
    persona.write_text(json.dumps([{"id": "system-prompt", "config": {
        "personaPrefix": (root / "prompts/office-system.md").read_text(encoding="utf-8").rstrip()
    }}], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    patches = (str(Path(__file__).with_name("chat.patch.yml")), str(persona))
    if mode == "ask":
        return patches + (str(Path(__file__).with_name("ask.patch.yml")),)
    # Reuse the same executable, arguments and whitelist as Codex / Claude.
    server = json.loads((root / "software/computer-use/mcp.json").read_text(encoding="utf-8-sig"))["mcpServers"]["windows-mcp"]
    patch = directory / "deepseek-mcp.patch.json"
    patch.write_text(json.dumps([{"insert": [{
        "id": "office-computer-use",
        "name": (root / ".runtime/deepseek-harness/npm/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js").as_posix(),
        "config": {"transport": "stdio", "serverName": "windows-mcp", **server,
                   "cwd": str(root), "reconnect": {"enabled": False}, "failOnStartupError": True}
    }, {
        "id": "office-memory-maintenance",
        "name": (root / "software/deepseek-harness/memory-tool.mjs").as_posix(),
        "config": {"runDirectory": str(directory)}
    }]}], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return patches + (str(patch),)


def main():
    if os.environ.get("PHD_ISOLATED_TESTS") == "1":
        raise RuntimeError("Real DeepSeek calls disabled in isolated tests")
    root = Path(__file__).resolve().parents[2]
    task_file = Path(sys.argv[1]).resolve()
    directory = task_file.parent
    task = json.loads(task_file.read_text(encoding="utf-8-sig"))
    try:
        credentials = load_connection(root)
        from deepseek_harness import DeepSeekHarness
        patches = chat_patches(root, directory, task.get("mode"))
        result = execute(task, directory, credentials, DeepSeekHarness, workspace=root,
                         dsh_home=Path.home() / ".dsh",
                         patches=patches,
                         emit=lambda event: print(json.dumps(event, ensure_ascii=False), flush=True),
                         run_session=run_interactive if task.get("mode") == "work" else None)
    except Exception as error:
        result = {"id": task["id"], "status": "failed", "usage_known": False,
                  "error": f"Local preparation failed: {type(error).__name__}"}
    (directory / "deepseek-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
