"""Local, on-demand dictation. One JSON request/reply per line; no microphone access."""
import json
import os
from pathlib import Path
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")
# NVIDIA's Windows pip wheels keep DLLs outside PATH. Register only this venv's DLLs.
dll_handles = []
if os.name == "nt":
    for folder in (Path(sys.prefix) / "Lib/site-packages/nvidia").glob("*/bin"):
        dll_handles.append(os.add_dll_directory(str(folder)))
        os.environ["PATH"] = str(folder) + os.pathsep + os.environ["PATH"]

from faster_whisper import WhisperModel
import av
import numpy as np


def decode_audio(file):
    # faster-whisper 1.2.1's decoder passes a removed PyAV 19 keyword.
    # Decode through PyAV's public API, without changing the shared recorder venv.
    parts = []
    samples = 0
    with av.open(file) as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in container.decode(audio=0):
            for output in resampler.resample(frame):
                array = output.to_ndarray().reshape(-1)
                samples += len(array)
                if samples > 120 * 16000:
                    raise ValueError("录音超过 2 分钟，请分段输入")
                parts.append(array)
        for output in resampler.resample(None):
            parts.append(output.to_ndarray().reshape(-1))
    return np.concatenate(parts).astype(np.float32) / 32768 if parts else np.zeros(0, dtype=np.float32)

model = None
for line in sys.stdin:
    try:
        request = json.loads(line)
        if model is None:
            model = WhisperModel(os.environ["OFFICE_SPEECH_MODEL"], device="cuda", compute_type="float16", local_files_only=True)
        audio = decode_audio(request["path"])
        segments, info = model.transcribe(
            audio, language=request.get("language"), beam_size=5,
            vad_filter=True, condition_on_previous_text=False,
        )
        text = "".join(segment.text for segment in segments).strip()
        print(json.dumps({"text": text, "language": info.language}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
