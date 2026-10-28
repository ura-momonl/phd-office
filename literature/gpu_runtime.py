"""GPU placement checks. No model imports or loading at module import time."""
from collections import Counter


def cuda_model_report(model, name):
    devices = Counter()
    for parameter in model.parameters():
        devices[str(parameter.device)] += parameter.numel()
    if not devices or any(not device.startswith('cuda:') for device in devices):
        raise RuntimeError(f'{name}: model parameters are not entirely on CUDA: {dict(devices)}')
    return {'model': name, 'parameter_devices': dict(devices)}


def cuda_session(ort, model_path, sess_options):
    """Require CUDA execution; allow ORT's CPU shape/control operators, not EP failure fallback."""
    if 'CUDAExecutionProvider' not in ort.get_available_providers():
        raise RuntimeError('ONNX Runtime CUDAExecutionProvider is unavailable')
    session = ort.InferenceSession(str(model_path), sess_options=sess_options, providers=[
        ('CUDAExecutionProvider', {'device_id': 0, 'cudnn_conv_algo_search': 'HEURISTIC',
                                   'arena_extend_strategy': 'kSameAsRequested'})])
    session.disable_fallback()
    if 'CUDAExecutionProvider' not in session.get_providers():
        raise RuntimeError(f'ONNX Runtime failed to initialize CUDA: {model_path}')
    return session
