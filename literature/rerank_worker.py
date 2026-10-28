"""文献库重排序 worker：输入 JSON [{"q": 查询, "docs": [文本,...]}, ...]，输出 JSON [[分数,...], ...]（与 docs 同序）。
用法：python rerank_worker.py <模型名> <输入.json> <输出.json> [--batch=16]
交叉编码器在本机 GPU 上 fp16 运行；没有 CUDA 时报错，不悄悄退回 CPU。不联网（模型须已缓存；首次下载由调用方设 RAG_ALLOW_DOWNLOAD=1）。
"""
import json
import sys
import time

import torch
from sentence_transformers import CrossEncoder
from gpu_runtime import cuda_model_report


def main():
    model_name, src, dst = sys.argv[1:4]
    batch = 16
    for a in sys.argv[4:]:
        if a.startswith("--batch="):
            batch = int(a.split("=", 1)[1])
    if not torch.cuda.is_available():
        sys.exit("CUDA 不可用：torch=%s cuda=%s" % (torch.__version__, torch.version.cuda))
    jobs = json.load(open(src, encoding="utf8"))
    t0 = time.time()
    model = CrossEncoder(model_name, device="cuda", max_length=512, model_kwargs={"torch_dtype": torch.float16})
    placement = cuda_model_report(model.model, model_name)
    t1 = time.time()
    out = []
    for j in jobs:
        s = model.predict([(j["q"], d) for d in j["docs"]], batch_size=batch, show_progress_bar=False)
        out.append([float(x) for x in s])
    json.dump(out, open(dst, "w"))
    print(json.dumps({"jobs": len(jobs), "pairs": sum(len(j["docs"]) for j in jobs), "load_s": round(t1 - t0, 1), "score_s": round(time.time() - t1, 1), **placement}))


if __name__ == "__main__":
    main()
