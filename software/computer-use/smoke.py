"""Explicit, foreground GUI acceptance. Only operates a new disposable test window.
Run with the installed venv Python, with normal desktop/subprocess authorization.
"""
import asyncio
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

TITLE = "Office Computer Use Acceptance"
EXPECTED = "computer use works - 中文测试"


def test_window(folder):
    import tkinter as tk
    folder = Path(folder)
    root = tk.Tk()
    root.title(TITLE)
    root.geometry("640x300+120+120")
    root.attributes("-topmost", True)
    tk.Label(root, text="Disposable desktop control test; no real documents", font=("Arial", 14)).pack(pady=20)
    entry = tk.Entry(root, font=("Arial", 16), width=40)
    entry.pack(pady=10)
    entry.insert(0, "REPLACE ME")
    label = tk.Label(root, text="Not submitted", font=("Arial", 14))
    def submit():
        text = entry.get()
        (folder / "actual.txt").write_text(text, encoding="utf-8")
        label.config(text="PASS" if text == EXPECTED else "FAIL", fg="green" if text == EXPECTED else "red")
    button = tk.Button(root, text="Verify test input", command=submit, font=("Arial", 14))
    button.pack(pady=15)
    label.pack()
    root.update()
    point = lambda w: [w.winfo_rootx()+w.winfo_width()//2, w.winfo_rooty()+w.winfo_height()//2]
    info = {"entry": point(entry), "button": point(button),
            "region": [root.winfo_rootx(), root.winfo_rooty(), root.winfo_rootx()+root.winfo_width(), root.winfo_rooty()+root.winfo_height()]}
    (folder / "geometry.json").write_text(json.dumps(info), encoding="utf-8")
    root.after(120000, root.destroy)
    root.mainloop()


async def smoke():
    from fastmcp import Client
    root = Path(__file__).resolve().parents[2]
    artifacts = root / ".runtime/computer-use/acceptance"
    artifacts.mkdir(parents=True, exist_ok=True)
    config = json.loads((root / "software/computer-use/mcp.json").read_text(encoding="utf-8"))
    server = config["mcpServers"]["windows-mcp"]
    allowed = server["args"][server["args"].index("--tools")+1].split(",")
    with tempfile.TemporaryDirectory(prefix="office-desktop-test-") as folder:
        child = subprocess.Popen([sys.executable, __file__, "--window", folder])
        try:
            geometry = Path(folder) / "geometry.json"
            for _ in range(100):
                if geometry.exists():
                    break
                if child.poll() is not None:
                    raise RuntimeError("Test window exited before becoming ready")
                await asyncio.sleep(.1)
            info = json.loads(geometry.read_text(encoding="utf-8"))
            async with Client(config, timeout=30) as client:
                tools = await client.list_tools()
                names = sorted(t.name for t in tools)
                assert names == sorted(allowed), names
                (artifacts / "tools.json").write_text(json.dumps([{"name": t.name, "schema": t.input_schema} for t in tools], ensure_ascii=False, indent=2), encoding="utf-8")
                async def call(name, args):
                    result = await client.call_tool(name, args)
                    texts = [b.text for b in result.content if getattr(b, "type", None) == "text"]
                    with (artifacts / "calls.jsonl").open("a", encoding="utf-8") as log:
                        log.write(json.dumps({"tool": name, "args": args, "text": texts}, ensure_ascii=False)+"\n")
                    assert not result.is_error, (name, result)
                    for block in result.content:
                        if getattr(block, "type", None) == "text":
                            assert not block.text.lower().startswith("error"), block.text
                    return result
                await call("App", {"mode": "switch", "name": TITLE})
                snap = await call("Snapshot", {"use_ui_tree": True, "region": info["region"]})
                assert any(TITLE in getattr(b, "text", "") for b in snap.content), "Test window missing from UI state"
                await call("Click", {"loc": info["entry"]})
                await call("Shortcut", {"shortcut": "ctrl+a"})
                await call("Shortcut", {"shortcut": "backspace"})
                await call("Click", {"loc": info["button"]})
                await asyncio.sleep(.2)
                assert (Path(folder) / "actual.txt").read_text(encoding="utf-8") == "", "Shortcut did not clear the test input"
                await call("Type", {"loc": info["entry"], "text": EXPECTED, "clear": True})
                await call("Click", {"loc": info["button"]})
                await asyncio.sleep(.3)
                actual = (Path(folder) / "actual.txt").read_text(encoding="utf-8")
                assert actual == EXPECTED, repr(actual)
                shot = await call("Screenshot", {"region": info["region"]})
                images = [b for b in shot.content if getattr(b, "type", None) == "image"]
                assert images, "No screenshot returned"
                (artifacts / "pass.png").write_bytes(base64.b64decode(images[0].data))
                report = {"passed": True, "tools": names, "actual": actual, "tested": ["stdio initialization", "tool allowlist", "App switch", "Snapshot", "Click", "Shortcut", "Type English and Chinese", "Screenshot"], "not_tested": ["real research applications", "Scroll", "Move/drag", "WaitFor", "multi-monitor"], "timestamp": time.strftime("%Y-%m-%d %H:%M:%S%z")}
                (artifacts / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
                print(json.dumps(report, ensure_ascii=False))
        finally:
            child.terminate()
            child.wait(timeout=10)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--window":
        test_window(sys.argv[2])
    else:
        asyncio.run(smoke())
