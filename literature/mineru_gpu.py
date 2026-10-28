"""Local GPU-only MinerU entry: python literature/mineru_gpu.py input.pdf -o output.md [--pages 1-2].

Torch layout/formula/OCR on CUDA; ONNX tables on CUDA; GGUF VLM on NVIDIA Vulkan.
CPU PDF/image preparation and ORT shape/control nodes are normal, not model fallback.
This process-local adapter does not edit upstream packages or global user settings.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from gpu_runtime import cuda_session


def configure_gpu():
    import torch
    import onnxruntime as ort
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable; refusing CPU model inference')
    torch.set_num_threads(2)
    ort.preload_dlls()
    if 'CUDAExecutionProvider' not in ort.get_available_providers():
        raise RuntimeError('Install onnxruntime-gpu==1.26.0 in the MinerU venv (CUDA 12.8)')
    os.environ['MINERU_DEVICE_MODE'] = 'cuda'
    os.environ['MINERU_TABLE_DEVICE'] = 'cuda'
    os.environ.setdefault('OMP_NUM_THREADS', '2')
    os.environ.setdefault('MINERU_INTRA_OP_NUM_THREADS', '2')
    os.environ.setdefault('MINERU_INTER_OP_NUM_THREADS', '1')

    from mineru.config import config
    if config.model.vlm.server_url:
        raise RuntimeError('This entry is local-only; remove the remote VLM server setting')
    config.model.small_backend = 'torch'
    config.model.vlm.engine = 'llama-cpp'

    # Table weights are ONNX even in the Torch repository. Replace only their
    # session factory before importing the parse pipeline (which binds aliases).
    from mineru.model.runtime import onnx as runtime_onnx

    def table_session(model_path, *, sess_options=None):
        opts = sess_options if sess_options is not None else ort.SessionOptions()
        runtime_onnx.configure_ort_threads(opts)
        opts.log_severity_level = 3
        profile_dir = os.getenv('MINERU_ONNX_PROFILE_DIR')
        if profile_dir:
            Path(profile_dir).mkdir(parents=True, exist_ok=True)
            opts.enable_profiling = True
            opts.profile_file_prefix = str(Path(profile_dir) / Path(model_path).stem)
        session = cuda_session(ort, model_path, opts)
        print(json.dumps({'table': Path(model_path).name, 'providers': session.get_providers()}), file=sys.stderr, flush=True)
        return session

    runtime_onnx.table_ort_session = table_session

    # Do not accidentally use the AMD integrated GPU or silently run a CPU VLM.
    import mineru_llama_cpp
    binary = Path(mineru_llama_cpp.__file__).parent / 'bin/llama-server.exe'
    env = dict(os.environ)
    env.pop('GGML_VK_VISIBLE_DEVICES', None)
    result = subprocess.run([str(binary), '--list-devices'], capture_output=True,
                            text=True, encoding='utf8', errors='replace', timeout=30,
                            env=env, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    name = torch.cuda.get_device_name(0)
    device = next((m.group(1) for line in result.stdout.splitlines()
                   if name in line and (m := re.search(r'Vulkan(\d+):', line))), None)
    if result.returncode or device is None:
        raise RuntimeError('The llama.cpp Vulkan backend cannot see the CUDA NVIDIA GPU')
    os.environ['GGML_VK_VISIBLE_DEVICES'] = device
    base_engine = mineru_llama_cpp.Engine

    class GPUOnlyEngine(base_engine):
        def __init__(self, model, mmproj, **kwargs):
            kwargs.update(n_gpu_layers=99, n_parallel=1, n_threads=2, verbosity=3)
            super().__init__(model, mmproj, **kwargs)

    mineru_llama_cpp.Engine = GPUOnlyEngine
    return {'gpu': name, 'small_backend': 'torch/cuda', 'tables': 'onnx/cuda',
            'vlm': f'llama.cpp/Vulkan{device}', 'ort': ort.__version__}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('-o', '--output', required=True, type=Path)
    parser.add_argument('--pages', default='')
    args = parser.parse_args()
    if not args.input.is_file():
        parser.error('Input file does not exist')
    if args.output.exists():
        parser.error('Output already exists; choose a new output path')
    print(json.dumps(configure_gpu()), file=sys.stderr, flush=True)
    from mineru.parser import parse
    from mineru.model.vlm.runtime import shutdown_cached_models
    try:
        result = parse(args.input, tier='standard', page_range=args.pages)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result.markdown(), encoding='utf8')
        print(json.dumps({'pages': len(result.pages), 'output': str(args.output)}))
    finally:
        shutdown_cached_models()


if __name__ == '__main__':
    main()
