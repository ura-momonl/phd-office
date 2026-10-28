"""Docling 解析 worker：python docling_worker.py <jobs.json>。jobs=[{"id","file","out"}]；每篇写 out（条目数组 [{p,label,level,text}]，p 为 PDF 页码）。
本机 GPU（CUDA）+ 自带 OCR（扫描版也能出字）；单篇失败只记录，不中断其余；不联网（模型须已缓存）。stdout 每篇一行 JSON：{"id","ok",...}。
"""
import json
import sys
import time
import torch

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import AcceleratorDevice, AcceleratorOptions, PdfPipelineOptions, RapidOcrOptions
from docling.document_converter import DocumentConverter, PdfFormatOption


def main():
    jobs = json.load(open(sys.argv[1], encoding="utf8"))
    if not torch.cuda.is_available():
        sys.exit("CUDA unavailable; refusing CPU model inference")
    torch.set_num_threads(2)
    opts = PdfPipelineOptions()
    opts.do_ocr = True
    opts.ocr_options = RapidOcrOptions(backend="torch")
    opts.accelerator_options = AcceleratorOptions(device=AcceleratorDevice.CUDA, num_threads=2)
    conv = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})
    for j in jobs:
        t = time.time()
        try:
            doc = conv.convert(j["file"]).document
            items = []
            for it, _ in doc.iterate_items():
                label = str(getattr(it, "label", "")).split(".")[-1].lower()
                prov = getattr(it, "prov", None)
                page = prov[0].page_no if prov else None
                try:
                    text = it.export_to_markdown(doc) if label == "table" else (getattr(it, "text", "") or "")
                except Exception:
                    text = getattr(it, "text", "") or ""
                if text.strip():
                    items.append({"p": page, "label": label, "level": getattr(it, "level", None), "text": text})
            json.dump(items, open(j["out"], "w", encoding="utf8"), ensure_ascii=False)
            print(json.dumps({"id": j["id"], "ok": True, "items": len(items), "sec": round(time.time() - t, 1)}), flush=True)
        except Exception as e:
            print(json.dumps({"id": j["id"], "ok": False, "error": str(e)[:200]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
