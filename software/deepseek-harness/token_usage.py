"""Translate recorded Harness notifications into observed office token usage.

Input includes cache reads/writes once. Incomplete runs keep their observed
lower bound; they are not silently turned into either zero or complete usage.
"""
import math


TOKEN_FIELDS = ("input_tokens", "cached_input_tokens", "cache_creation_tokens", "output_tokens")


def summarize_usage(events):
    totals = dict.fromkeys(TOKEN_FIELDS, 0)
    seen, complete = 0, True
    for event in events:
        kind = event.get("type", "")
        if kind == "assistant/attempt" or kind.startswith("compaction/"):
            complete = False
        if kind != "assistant/message":
            continue
        usage = event.get("data", {}).get("usage") or {}
        fields = [usage.get("inputTokens"), usage.get("outputTokens"),
                  usage.get("cacheReadTokens", 0), usage.get("cacheWriteTokens", 0)]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or
               not math.isfinite(v) or v < 0 for v in fields):
            complete = False
            continue
        direct, output, cached, created = fields
        totals["input_tokens"] += direct + cached + created
        totals["cached_input_tokens"] += cached
        totals["cache_creation_tokens"] += created
        totals["output_tokens"] += output
        seen += 1
    return seen > 0 and complete, totals if seen else None


def summarize_notifications(notifications, session_id, *, completed=True):
    # A trace can contain several office invocations. Only this root and its
    # explicitly registered descendants belong to this ledger row.
    edges, finished = set(), {}
    for notice in notifications:
        p = notice.get("payload", {})
        if notice.get("method") in ("subagent.started", "subagent.finished"):
            if p.get("parentSessionId") and p.get("childSessionId"):
                edges.add((p["parentSessionId"], p["childSessionId"]))
                if notice["method"] == "subagent.finished":
                    finished[p["childSessionId"]] = p.get("status") == "ok" and p.get("stopReason") == "completed"
        if notice.get("method") == "session.event" and p.get("event", {}).get("type") == "subagent/catalog":
            child = p["event"].get("data", {}).get("childId")
            if p.get("sessionId") and child:
                edges.add((p["sessionId"], child))
    sessions = {session_id}
    while True:
        expanded = sessions | {child for parent, child in edges if parent in sessions}
        if expanded == sessions:
            break
        sessions = expanded
    events = {sid: [] for sid in sessions}
    seen = set()
    for notice in notifications:
        p = notice.get("payload", {})
        sid, event = p.get("sessionId"), p.get("event")
        if notice.get("method") != "session.event" or sid not in sessions or not isinstance(event, dict):
            continue
        seq = event.get("seq")
        if seq is not None:
            identity = (sid, seq)
            if identity in seen:
                continue
            seen.add(identity)
        events[sid].append(event)
    totals, observed, complete = dict.fromkeys(TOKEN_FIELDS, 0), False, completed
    for sid, stream in events.items():
        known, usage = summarize_usage(stream)
        complete = complete and known and (sid == session_id or finished.get(sid, False))
        if usage is not None:
            observed = True
            for key in TOKEN_FIELDS:
                totals[key] += usage[key]
    return {"usage_known": bool(observed and complete),
            "usage_partial": bool(observed and not complete),
            "usage": totals if observed else None,
            "tool_calls": sum(e.get("type") == "tool/call" for e in events[session_id])}
