"""No torch/ORT/model loading: exercise the deployment guards with independent fakes."""
from types import SimpleNamespace
import unittest

from gpu_runtime import cuda_model_report, cuda_session


class PlacementTests(unittest.TestCase):
    def model(self, *devices):
        return SimpleNamespace(parameters=lambda: iter(
            SimpleNamespace(device=d, numel=lambda: 10) for d in devices))

    def test_cuda_parameters(self):
        self.assertEqual(cuda_model_report(self.model('cuda:0', 'cuda:0'), 'x')['parameter_devices'], {'cuda:0': 20})

    def test_cpu_or_offloaded_parameter_rejected(self):
        for devices in [('cpu',), ('cuda:0', 'cpu'), ('meta',), ()]:
            with self.subTest(devices=devices), self.assertRaises(RuntimeError):
                cuda_model_report(self.model(*devices), 'x')

    def test_cuda_not_compiled(self):
        ort = SimpleNamespace(get_available_providers=lambda: ['CPUExecutionProvider'])
        with self.assertRaises(RuntimeError):
            cuda_session(ort, 'x.onnx', object())

    def test_session_silent_fallback_rejected(self):
        s = SimpleNamespace(disable_fallback=lambda: None, get_providers=lambda: ['CPUExecutionProvider'])
        ort = SimpleNamespace(get_available_providers=lambda: ['CUDAExecutionProvider'], InferenceSession=lambda *a, **kw: s)
        with self.assertRaises(RuntimeError):
            cuda_session(ort, 'x.onnx', object())

    def test_success_disables_runtime_fallback_and_requests_cuda(self):
        calls = {}
        def session(*args, **kwargs):
            calls.update(kwargs)
            return SimpleNamespace(disable_fallback=lambda: calls.update(disabled=True),
                                   get_providers=lambda: ['CUDAExecutionProvider', 'CPUExecutionProvider'])
        ort = SimpleNamespace(get_available_providers=lambda: ['CUDAExecutionProvider'], InferenceSession=session)
        cuda_session(ort, 'x.onnx', object())
        self.assertTrue(calls['disabled'])
        self.assertEqual([p[0] for p in calls['providers']], ['CUDAExecutionProvider'])

    def test_initialization_error_propagates_without_cpu_retry(self):
        def broken(*a, **kw):
            raise RuntimeError('CUDA DLL missing')
        ort = SimpleNamespace(get_available_providers=lambda: ['CUDAExecutionProvider'], InferenceSession=broken)
        with self.assertRaisesRegex(RuntimeError, 'CUDA DLL missing'):
            cuda_session(ort, 'x.onnx', object())


if __name__ == '__main__':
    unittest.main()
