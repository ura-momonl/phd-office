# 文献库用到的本地模型清单（2026-10-20 整理）

原则：模型推理在本机 GPU 上跑，按需串行加载，不要求所有模型同时常驻显存。`embed_worker.py` 和 `rerank_worker.py` 检查权重全部位于 CUDA；MinerU 使用本项目的 `mineru_gpu.py` 入口，不接受整模型 CPU 回退。PDF/图像预处理、分词及部分形状/索引/控制算子仍使用 CPU。

| 环节 | 模型／工具 | 位置 | 大小 | 设备与说明 |
|---|---|---|---|---|
| 已停用（仅保留安装） | Docling（layout-heron、docling-models、RapidOCR） | 环境 `.runtime/tools/docling/venv`；权重在 `~/.cache/huggingface/hub`（共约 0.5 GB） | 环境约 5.0 GB | 不再用于入库或失败回退；未删除环境和旧缓存 |
| 全部入库解析 | MinerU 4.0.12：版面／公式／OCR 用 PyTorch，三个表格模型仍是 ONNX；视觉模型 MinerU2.5-Pro 1.2B（GGUF Q8，llama.cpp） | 环境 `.runtime/tools/mineru/venv`；权重在 `~/.mineru/models`（`MinerU-4_models_torch` 约 0.85 GB + `MinerU2.5-Pro-2605-1.2B-GGUF` 约 1.2 GB） | 环境约 4.9 GB | `literature/mineru_worker.py` 复用 `mineru_gpu.py`：小模型强制 CUDA，表格使用 ORT CUDA、初始化失败即报错；视觉模型限制到 NVIDIA Vulkan、99 GPU layers、单并发 |
| 向量 | Qwen3-Embedding-4B，8 位预量化（**与长期记忆 memory2 共用同一个常驻实例**） | `.runtime/tools/embed/qwen3-4b-int8`（`library.mjs` 的 `LOCAL_QUANT_DIRS`） | 4.2 GB | GPU，bitsandbytes 8 位。由 `memory2/embed_server.py` 常驻服务（按需启动，空闲 10 分钟退出），文献库经 `memory2/embed-cli.mjs` 调用，不再每次另起进程加载；两边各加载一份放不进 8 GB。服务端计算后整卡约 4.9 GB（含桌面与驱动）。向量与 `embed_worker.py` 逐值相同（40 条真实摘要 + 3 条查询核对）；`RAG_EMBED_STANDALONE=1` 可退回一次一进程的旧方式。库里 54 317 块是 5080 上用 fp16 算的（2560 维），查询用 int8，余弦约 0.997 |
| 重排序 | BAAI/bge-reranker-v2-m3 | `~/.cache/huggingface/hub` | 2.1 GB | GPU fp16，`--rerank` 时才加载 |
| 语音转文字 | Whisper Turbo | `D:/Zoom-recordings/quiet-recorder`（不属于本项目，不要改） | — | 已强制 CUDA，见 `software/quiet-recorder/WORKBENCH-VOICE.md` |

非模型的 CPU 工具（保留）：`pdftotext`（Poppler 26.09.0）用于下载后的 PDF 身份校验和显式提字诊断，不再用于入库回退；它不是神经网络模型。本机便携版在 `.runtime/tools/poppler/Library/bin/pdftotext.exe`，安装来源与哈希在 `.runtime/tools/poppler/install.json`；调用共用 `pdf-tools.mjs`，优先显式 `PDFTOTEXT`、再选项目内便携版，最后才用 PATH，不依赖 MiKTeX。

## 2026-10-20 已删除
- MinerU 的 ONNX（CPU）小模型 `MinerU-4_models_onnx`（约 0.8 GB）及其 HF 缓存引用。
- Qwen3-Embedding-4B 的 fp16 权重（HF 缓存 15 GB，含重复副本）：本机放不下，只留 int8 目录。
- 已被取代的旧向量模型 bge-m3（4.3 GB）和 Qwen3-Embedding-0.6B（1.1 GB）。
- 评测与 5080 运行包的临时文件：`gpu-pack.zip`、量化评测副本、样本 PDF 副本、`.runtime/exp`（含 530 MB 中间文件）。
- 可重新下载（`RAG_ALLOW_DOWNLOAD=1`）；整库回滚快照 `.runtime/literature-edits/20261020-qwen3/`（bge-m3 向量）和 `20261020-qwen3-4b/`（0.6B 向量）还在，但要回滚必须先重新下载对应模型。

## 需要时怎么重建
- int8 向量模型目录：`.runtime/tools/embed/venv/Scripts/python.exe literature/quantize_embed_model.py`（需联网下载约 8 GB fp16 权重，量化约 5 分钟，请在没有其他 GPU 任务时运行）。
- MinerU GPU 版权重：`.runtime/tools/mineru/venv/Scripts/mineru-kit.exe models download --tier standard --small-backend torch`，校验用 `mineru-kit models verify`。

## MinerU 本机 GPU 使用入口

后续入库直接用 `node automation/run.mjs literature library ingest [条数]` 或 `library update`，全部走 MinerU，不回退其他解析器。已有索引不自动重建；已有文献的批量解析由 5080 另行处理。

`.runtime/tools/mineru/venv/Scripts/python.exe literature/mineru_gpu.py input.pdf -o output.md --pages 1-2`。不传 `--pages` 则解析整篇；输出路径须尚不存在。直接调用上游 `mineru-kit parse` 不经过本项目的 GPU 守卫，不作为办公室 GPU 入口。

环境固定 `onnxruntime-gpu==1.26.0`，与现有 `torch 2.11.0+cu128` 的 CUDA 12.8 / cuDNN 9 对齐，不同时安装 CPU 包 `onnxruntime`。新版 GPU wheel 可能使用 CUDA 13，不应盲目升级；见 [官方兼容表](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#requirements)。

## 没有清理的
- `MinerU-4_models_torch/Table` 中的三个 `.onnx` 权重是必需资源，ONNX 是格式而非 CPU 专用模型，不应删除；使用 GPU Runtime 加载。MinerU 上游依赖元数据仍要求包名 `onnxruntime`，GPU 发行包提供同一 Python 模块但包名不同，`pip check` 会报缺项；不要据此补装 CPU 包覆盖 GPU 模块。
- `.runtime/gpu-pack/` 还留着 5080 上算好的 4B fp16 向量（约 270 MB，`out/Qwen_Qwen3-Embedding-4B`）：整库向量丢失时可直接重新导入，省掉 45 分钟的 5080 计算。
