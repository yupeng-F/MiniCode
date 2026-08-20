from __future__ import annotations

import os

from dotenv import load_dotenv

from minicode.engine.model_catalog import DEFAULT_MODEL_ID, UnsupportedModelError, get_model_profile
from minicode.engine.model_client import ModelClient
from minicode.engine.providers.deepseek import DeepSeekModelClient


class ModelConfigurationError(ValueError):
    pass


class ModelFactory:
    @staticmethod
    def from_environment(
        model: str | None = None,
        load_dotenv_file: bool = True,
    ) -> ModelClient:
        if load_dotenv_file:
            load_dotenv(override=False)

        provider = os.getenv("MINICODE_MODEL_PROVIDER", "deepseek").strip().lower()
        if provider != "deepseek":
            raise ModelConfigurationError(f"Unsupported model provider: {provider}")

        api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
        if not api_key:
            raise ModelConfigurationError("DEEPSEEK_API_KEY is required for the DeepSeek provider")

        base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").strip().rstrip("/")
        if not base_url.startswith(("https://", "http://")):
            raise ModelConfigurationError("DEEPSEEK_BASE_URL must be an HTTP(S) URL")

        selected_model = model or os.getenv("MINICODE_MODEL", DEFAULT_MODEL_ID).strip() or DEFAULT_MODEL_ID
        try:
            profile = get_model_profile(selected_model)
        except UnsupportedModelError as exc:
            raise ModelConfigurationError(str(exc)) from exc

        return DeepSeekModelClient(
            api_key=api_key,
            model=profile.id,
            base_url=base_url,
        )
