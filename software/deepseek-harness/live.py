"""Bridge office inputs into the SDK's native inbox, without replay or polling."""
import json
import queue
import sys
import threading
from types import SimpleNamespace


def run_interactive(harness, task, on_notification, *, source=None):
    from deepseek_harness.api import final_response, finish_reason

    source = sys.stdin if source is None else source
    client, session_id = harness.client, task["id"]
    incoming = queue.Queue()
    pending, inserted, events = {}, set(), []
    idle = False

    def notice(method, payload):
        on_notification(SimpleNamespace(method=method, payload=payload))

    def send(request, subscription):
        try:
            message_id = client.session_prompt(session_id, [{"type": "text", "text": request["text"]}],
                                               notification_subscription=subscription)
            incoming.put(("sent", (request["id"], message_id)))
        except Exception as error:
            incoming.put(("rejected", (request["id"], str(error))))

    def read_inputs():
        try:
            for line in source:
                request = json.loads(line)
                if not isinstance(request.get("id"), str) or not isinstance(request.get("text"), str):
                    raise ValueError("Invalid office input")
                incoming.put(("input", request))
        except Exception as error:
            incoming.put(("input-error", str(error)))

    with client.subscribe_session_notifications(session_id) as subscription:
        initial_id = client.session_prompt(session_id, [{"type": "text", "text": task["prompt"]}],
                                           notification_subscription=subscription)

        def read_native():
            try:
                while True:
                    incoming.put(("native", subscription.next()))
            except Exception as error:
                incoming.put(("closed", error))

        threading.Thread(target=read_native, daemon=True).start()
        threading.Thread(target=read_inputs, daemon=True).start()
        notice("office.ready", {"sessionId": session_id})
        received_initial = False
        while True:
            kind, value = incoming.get()
            if kind == "input":
                if value["id"] in pending:
                    raise ValueError("Duplicate office input id")
                pending[value["id"]] = None
                # A request response is not an inbox receipt. Send independently
                # so one delayed response never holds the next user's message.
                threading.Thread(target=send, args=(value, subscription), daemon=True).start()
            elif kind == "sent":
                request_id, message_id = value
                pending[request_id] = message_id
            elif kind == "rejected":
                request_id, error = value
                pending.pop(request_id, None)
                notice("office.input", {"id": request_id, "accepted": False, "error": error})
            elif kind in ("closed", "input-error"):
                raise RuntimeError(str(value))
            elif kind == "native":
                n = value
                root = n.payload.get("sessionId") == session_id
                event = n.payload.get("event", {}) if n.method == "session.event" else {}
                if root and event.get("type") == "agent/inbox/spliced":
                    ids = {m.get("id") for m in event.get("data", {}).get("inserted", []) if isinstance(m, dict)}
                    inserted.update(ids)
                    received_initial = received_initial or initial_id in ids
                    # Even if an earlier idle notice raced this splice, wait
                    # for the native idle AFTER this accepted message.
                    idle = False
                if received_initial:
                    on_notification(n)
                    if root and isinstance(n.payload.get("event"), dict):
                        events.append(n.payload["event"])
                    if root and n.method == "session.status":
                        idle = n.payload.get("status") == "idle"
            for request_id, message_id in list(pending.items()):
                if message_id is not None and message_id in inserted:
                    del pending[request_id]
                    notice("office.input", {"id": request_id, "accepted": True})
            if received_initial and idle and not pending:
                break
    return SimpleNamespace(final_response=final_response(events), finish_reason=finish_reason(events))
