"""memory2 embedding service: loads the local Qwen3-Embedding int8 model on the GPU once and answers /embed on loopback.

Usage: python embed_server.py --model-dir <dir> --info <info.json> [--idle 600] [--batch 16]
- Binds 127.0.0.1 on an ephemeral port; a random bearer token is written to the info file together with pid/port/model.
- The info file is written only after the model is on CUDA (it doubles as the readiness signal) and removed on exit.
- Exits by itself after --idle seconds without a request, so VRAM is returned to MinerU / literature jobs.
- No CUDA -> exit with an error (never a silent CPU fallback), same rule as literature/embed_worker.py.
It only turns text into vectors; it stores nothing.
"""
import argparse
import base64
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "literature"))

import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from gpu_runtime import cuda_model_report


_instance_lock = None  # held for the whole process lifetime; the OS releases it when the process dies


def hold_single_instance(info_path):
    """At most one server per info file, whatever the clients' start-up race did: a second one would load a second copy onto the GPU."""
    global _instance_lock
    f = open(info_path + ".server.lock", "a+")
    try:
        if sys.platform == "win32":
            import msvcrt
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another embed server already holds %s; exiting" % info_path, file=sys.stderr)
        sys.exit(0)
    _instance_lock = f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--info", required=True)
    ap.add_argument("--idle", type=int, default=600)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--model-name", default="Qwen/Qwen3-Embedding-4B")
    args = ap.parse_args()
    if args.batch < 1:
        ap.error("--batch must be positive")
    hold_single_instance(args.info)
    if not torch.cuda.is_available():
        sys.exit("CUDA 不可用：torch=%s cuda=%s" % (torch.__version__, torch.version.cuda))
    model = SentenceTransformer(args.model_dir,
                                model_kwargs={"torch_dtype": torch.float16, "device_map": {"": 0}},
                                config_kwargs={"use_cache": False})
    model.max_seq_length = 512
    placement = cuda_model_report(model, args.model_name)
    # Embedding is a full forward pass, not autoregressive generation: no KV cache.
    # Return unused allocator blocks to other GPU jobs, without moving weights off CUDA.
    torch.cuda.empty_cache()

    def gpu_memory():
        return {"allocated_mib": round(torch.cuda.memory_allocated() / 2**20, 1),
                "reserved_mib": round(torch.cuda.memory_reserved() / 2**20, 1),
                "peak_allocated_mib": round(torch.cuda.max_memory_allocated() / 2**20, 1),
                "peak_reserved_mib": round(torch.cuda.max_memory_reserved() / 2**20, 1)}

    has_query_prompt = "query" in (getattr(model, "prompts", None) or {})
    token = secrets.token_hex(24)
    state = {"last": time.time(), "lock": threading.Lock(), "gpu": gpu_memory()}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode("utf8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self):
            return self.headers.get("Authorization") == "Bearer " + token

        def do_GET(self):
            if self.path == "/health" and self._authorized():
                return self._send(200, {"ok": True, "model": args.model_name, "pid": os.getpid(),
                                        "batch": args.batch, "max_seq_length": model.max_seq_length,
                                        "gpu": state["gpu"]})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/embed" or not self._authorized():
                return self._send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                req = json.loads(self.rfile.read(n).decode("utf8"))
                texts = req["texts"]
                if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                    return self._send(400, {"error": "texts must be a list of strings"})
                kw = {"prompt_name": "query"} if req.get("query") and has_query_prompt else {}
                with state["lock"]:  # one GPU job at a time
                    state["last"] = time.time()
                    error = None
                    try:
                        vecs = model.encode(texts, **kw, batch_size=args.batch, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
                    except Exception as e:
                        # Drop the traceback (and its tensor references) before empty_cache.
                        error = str(e)[:500]
                    finally:
                        torch.cuda.empty_cache()
                        state["gpu"] = gpu_memory()
                        state["last"] = time.time()
                if error is not None:
                    return self._send(500, {"error": error})
                vecs = np.asarray(vecs, dtype="<f4")
                self._send(200, {"n": len(texts), "dim": int(vecs.shape[1]) if len(texts) else 0, "vectors": base64.b64encode(vecs.tobytes()).decode("ascii")})
            except Exception as e:  # report, keep serving
                self._send(500, {"error": str(e)[:500]})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]

    def cleanup():
        try:
            os.remove(args.info)
        except OSError:
            pass

    def idle_watch():
        while True:
            time.sleep(5)
            with state["lock"]:
                idle = time.time() - state["last"]
            if idle > args.idle:
                cleanup()
                os._exit(0)

    threading.Thread(target=idle_watch, daemon=True).start()
    tmp = args.info + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump({"pid": os.getpid(), "port": port, "token": token, "model": args.model_name, "started": time.time(), **placement}, f)
    os.replace(tmp, args.info)
    try:
        server.serve_forever()
    finally:
        cleanup()


if __name__ == "__main__":
    main()
