"""Select the office's DeepSeek transport without changing the native harness."""
import json
from pathlib import Path


def load_connection(root):
    selection = root / ".runtime/deepseek-harness/provider.json"
    provider = json.loads(selection.read_text(encoding="utf-8-sig"))["provider"] if selection.exists() else "official"
    if provider not in ("official", "commandcode"):
        raise ValueError("Unknown DeepSeek provider")
    file = root / (".runtime/commandcode/credentials.json" if provider == "commandcode" else ".runtime/deepseek-harness/credentials.json")
    credentials = json.loads(file.read_text(encoding="utf-8-sig"))
    if not isinstance(credentials.get("api_key"), str) or not credentials["api_key"].strip():
        raise ValueError("Missing API key")
    if provider == "commandcode" and credentials.get("base_url") != "https://api.commandcode.ai/provider/v1":
        raise ValueError("Unexpected Command Code endpoint")
    return {**credentials, "provider": provider}


def wire_effort(credentials, effort):
    """Office effort name -> the level name the harness gets. Only Command Code needs a translation for "off"."""
    return "minimal" if credentials.get("provider") == "commandcode" and effort == "off" else effort


def connection_options(root, directory, credentials, model):
    if credentials.get("provider", "official") == "official":
        if model == "deepseek-flash-fast":
            raise ValueError("DeepSeek fast is only available through Command Code")
        return {"provider": "deepseek-official", "model": model,
                "api_key": credentials["api_key"], "base_url": credentials["base_url"]}, ()
    if credentials.get("provider") != "commandcode":
        raise ValueError("Unknown DeepSeek provider")
    if credentials.get("base_url") != "https://api.commandcode.ai/provider/v1":
        raise ValueError("Unexpected Command Code endpoint")
    # Office aliases: deepseek-flash = normal V4.1 Flash, deepseek-flash-fast = the Fast variant.
    actual = {"deepseek-flash": "deepseek/deepseek-v4.1-flash", "deepseek-v4-flash": "deepseek/deepseek-v4.1-flash",
              "deepseek-flash-fast": "deepseek/deepseek-v4.1-flash-fast"}.get(model, model)
    allowed = {"deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash-fast",
               "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-fast", "deepseek/deepseek-v4-pro"}
    if actual not in allowed:
        raise ValueError("Unsupported Command Code DeepSeek model")
    patch = directory / "commandcode.patch.json"
    patch.write_text(json.dumps([{
        "id": "llm-pi-ai",
        "config": {"providers": {"office-commandcode": {
            "displayName": "Command Code DeepSeek", "api": "openai-completions",
            "apiKeyEnv": "OFFICE_COMMANDCODE_API_KEY", "baseURL": credentials["base_url"],
            # Upstream drops long streams ("terminated") and stalls on big contexts.
            # A bounded normal policy re-runs only the failed step (TRANSPORT/TIMEOUT/
            # SERVER/RATE_LIMIT/EMPTY_RESPONSE), so successful turns keep their latency
            # and output; the executor is dsh-llm-retry, mounted in chat.patch.yml.
            "retryPolicy": {"mode": "normal", "maxRetries": 3,
                            "backoff": {"initialDelayMs": 1000, "maxDelayMs": 10000}},
            "models": [{"id": actual, "contextWindow": 1000000, "maxTokens": 384000,
                        "input": (["text", "image"] if actual in (
                            "deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash-fast") else ["text"]),
                        # Command Code only switches thinking off with reasoning_effort="off"; pi-ai sends nothing for its own "off" level, so the
                        # server default (thinking on) would apply. The office "off" is therefore sent as the spare level "minimal" (see wire_effort).
                        "reasoningEfforts": {"off": None, "minimal": "off", "low": "low", "high": "high", "max": "max"}}],
            "compat": {"supportsStore": False, "supportsDeveloperRole": False,
                       "supportsReasoningEffort": True, "thinkingFormat": "deepseek",
                       "requiresReasoningContentOnAssistantMessages": True,
                       "maxTokensField": "max_tokens", "supportsStrictMode": False}
        }}}
    }], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"provider": "office-commandcode", "model": actual,
            # Node's 250ms dual-stack race can abandon a working IPv4 address
            # before this host's ~400ms TCP handshake completes, then stall on
            # IPv6. Keep both address families; allow 1.5s per connection attempt.
            # This is local to the Command Code runtime and its child tools.
            "env": {"OFFICE_COMMANDCODE_API_KEY": credentials["api_key"],
                    "NODE_OPTIONS": "--network-family-autoselection-attempt-timeout=1500"}}, (str(patch),)
