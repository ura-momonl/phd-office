"""文献库向量化 worker：读 jsonl（每行一个 JSON 字符串），写 float32 小端二进制（行数 x dim，已归一化）。
用法：python embed_worker.py <模型名> <输入.jsonl> <输出.f32> [--batch=32]
模型在本机 GPU（cuda）上以 fp16 运行；没有 CUDA 时报错而不是悄悄退回 CPU（让调用方知道）。
只做计算，不联网以外的事：首次运行会从 HuggingFace 下载模型到默认缓存。
"""
import json
import os
import sys
import time

import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from gpu_runtime import cuda_model_report


def main():
    model_name, src, dst = sys.argv[1:4]
    batch = 32
    is_query = "--query" in sys.argv[4:]
    for a in sys.argv[4:]:
        if a.startswith("--batch="):
            batch = int(a.split("=", 1)[1])
    if not torch.cuda.is_available():
        sys.exit("CUDA 不可用：torch=%s cuda=%s" % (torch.__version__, torch.version.cuda))
    texts = [json.loads(line) for line in open(src, encoding="utf8") if line.strip()]
    t0 = time.time()
    if os.path.isdir(model_name):
        # 本地预量化模型目录（如 qwen3-4b-int8，bitsandbytes 8 位，约 4.4 GB 显存）：量化配置在目录的 config.json 里，直接加载到 GPU。
        model = SentenceTransformer(model_name, model_kwargs={"torch_dtype": torch.float16, "device_map": {"": 0}})
    else:
        model = SentenceTransformer(model_name, device="cuda", model_kwargs={"torch_dtype": torch.float16})
    model.max_seq_length = 512
    placement = cuda_model_report(model, model_name)
    t1 = time.time()
    # 模型自带 query 提示词（如 Qwen3-Embedding）时，查询用它；bge-m3 没有，行为不变。
    kw = {"prompt_name": "query"} if is_query and "query" in (getattr(model, "prompts", None) or {}) else {}
    vecs = model.encode(texts, **kw, batch_size=batch, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    vecs = np.asarray(vecs, dtype="<f4")
    vecs.tofile(dst)
    print(json.dumps({"n": len(texts), "dim": int(vecs.shape[1]), "load_s": round(t1 - t0, 1),
                      "encode_s": round(time.time() - t1, 1), "device": torch.cuda.get_device_name(0), **placement}))


if __name__ == "__main__":
    main()
