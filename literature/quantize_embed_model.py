"""生成本机用的 Qwen3-Embedding-4B 8 位预量化模型目录（fp16 权重 8.1 GB 放不进 8 GB 显存，所以不存 fp16，只存这份约 4.2 GB 的目录）。
用法：.runtime/tools/embed/venv/Scripts/python.exe literature/quantize_embed_model.py
需要联网下载一次 fp16 权重（设 HF_HUB_OFFLINE=0，约 8 GB，写进 HF 缓存）；生成后可删掉 HF 缓存里的 models--Qwen--Qwen3-Embedding-4B。
输出：.runtime/tools/embed/qwen3-4b-int8（literature/library.mjs 的 LOCAL_QUANT_DIRS 指向它，加载约 5 秒，显存约 4.4 GB，向量与 fp16 余弦约 0.997）。
这一步会把模型整个载入 GPU 做量化（约 4～5 分钟，峰值显存约 6.5 GB），请在没有其他 GPU 任务时运行。
"""
import os
import sys

import torch
from sentence_transformers import SentenceTransformer
from transformers import BitsAndBytesConfig

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, ".runtime", "tools", "embed", "qwen3-4b-int8")


def main():
    if not torch.cuda.is_available():
        sys.exit("CUDA 不可用，不能量化")
    model = SentenceTransformer("Qwen/Qwen3-Embedding-4B", model_kwargs={
        "quantization_config": BitsAndBytesConfig(load_in_8bit=True), "device_map": {"": 0}, "torch_dtype": torch.float16})
    model.save(OUT)
    print("已保存", OUT)


if __name__ == "__main__":
    main()
