"""Run an explicit tool-call list in one Transport Workbench MCP session."""
import argparse
import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SERVER = Path("D:/Main/transport-workbench-mcp/server.py")


async def execute(calls):
    params = StdioServerParameters(command=sys.executable, args=["-B", "-I", str(SERVER)])
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            if calls is None:
                listed = await session.list_tools()
                return {"tools": [t.model_dump(mode="json") for t in listed.tools]}, True
            results = []
            for call in calls:
                response = await session.call_tool(call["tool"], call.get("arguments", {}))
                result = response.structuredContent
                if result is None:
                    result = [c.model_dump(mode="json") for c in response.content]
                    if len(response.content) == 1 and response.content[0].type == "text":
                        try:
                            result = json.loads(response.content[0].text)
                        except json.JSONDecodeError:
                            pass
                results.append({"tool": call["tool"], "is_error": bool(response.isError), "result": result})
                if response.isError:
                    return {"results": results, "complete": False}, False
            return {"results": results, "complete": True}, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", nargs="?", help="UTF-8 JSON array of {tool, arguments}; omitted: list tools")
    parser.add_argument("--output", help="Write JSON response to this UTF-8 file instead of stdout")
    args = parser.parse_args()
    calls = json.loads(Path(args.request).read_text(encoding="utf-8-sig")) if args.request else None
    if calls is not None and (not isinstance(calls, list) or not all(
        isinstance(c, dict) and isinstance(c.get("tool"), str) and isinstance(c.get("arguments", {}), dict)
        for c in calls
    )):
        parser.error("request must be an array of {tool: string, arguments: object}")
    result, ok = asyncio.run(execute(calls))
    encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    if args.output:
        path = Path(args.output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(encoded, encoding="utf-8")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(encoded, end="")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
