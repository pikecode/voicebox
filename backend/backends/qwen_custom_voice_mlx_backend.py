"""Apple Silicon CustomVoice using existing Qwen weights through mlx-audio."""

import asyncio
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from . import LANGUAGE_CODE_TO_NAME
from .qwen_custom_voice_backend import QwenCustomVoiceBackend, QWEN_CV_DEFAULT_SPEAKER

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="customvoice-mlx")


class QwenCustomVoiceMLXBackend(QwenCustomVoiceBackend):
    def __init__(self, model_size="1.7B"):
        super().__init__(model_size)
        self.device = "mlx"
        self._lock = asyncio.Lock()

    async def _run(self, func):
        return await asyncio.get_running_loop().run_in_executor(_executor, func)

    def _load_model_sync(self, model_size):
        from mlx_audio.tts.utils import load_model
        from huggingface_hub import snapshot_download

        # Resolve the complete snapshot, including the nested speech tokenizer.
        path = snapshot_download(self._get_model_path(model_size))
        self.model = load_model(path)
        self._current_model_size = model_size
        self.model_size = model_size

    async def load_model_async(self, model_size=None):
        async with self._lock:
            await self._ensure_loaded(model_size or self.model_size)

    load_model = load_model_async

    async def _ensure_loaded(self, size):
        if self.model is None or self._current_model_size != size:
            await self._run(lambda: self._load_model_sync(size))

    def unload_model(self):
        # Serialize Metal operations with generation on the dedicated worker.
        def unload():
            import mlx.core as mx
            self.model = None
            self._current_model_size = None
            mx.clear_cache()
        _executor.submit(unload).result()

    async def generate(self, text, voice_prompt, language="en", seed=None, instruct=None):
        async with self._lock:
            await self._ensure_loaded(self.model_size)

            def generate_sync():
                import mlx.core as mx
                if seed is not None:
                    mx.random.seed(seed)
                results = list(self.model.generate_custom_voice(
                    text=text,
                    speaker=voice_prompt.get("preset_voice_id") or QWEN_CV_DEFAULT_SPEAKER,
                    language=LANGUAGE_CODE_TO_NAME.get(language, "auto").capitalize(),
                    instruct=instruct or "",
                ))
                if not results:
                    raise RuntimeError("CustomVoice generated no audio")
                audio = mx.concatenate([result.audio for result in results])
                mx.eval(audio)
                return np.asarray(audio, dtype=np.float32), results[0].sample_rate

            return await self._run(generate_sync)
