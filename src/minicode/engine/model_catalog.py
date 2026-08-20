from __future__ import annotations

from dataclasses import dataclass


DEFAULT_MODEL_ID = "deepseek-v4-flash"


class UnsupportedModelError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class ModelProfile:
    id: str
    label: str
    provider: str
    context_window: int
    max_output_tokens: int

    def model_dump(self) -> dict[str, object]:
        return {
            "id": self.id,
            "label": self.label,
            "provider": self.provider,
            "context_window": self.context_window,
            "max_output_tokens": self.max_output_tokens,
        }


MODEL_PROFILES = (
    ModelProfile(
        id="deepseek-v4-flash",
        label="DeepSeek V4 Flash（快速）",
        provider="deepseek",
        context_window=65_536,
        max_output_tokens=8_000,
    ),
    ModelProfile(
        id="deepseek-v4-pro",
        label="DeepSeek V4 Pro（增强）",
        provider="deepseek",
        context_window=65_536,
        max_output_tokens=8_000,
    ),
)

_MODEL_BY_ID = {profile.id: profile for profile in MODEL_PROFILES}


def get_model_profile(model_id: str) -> ModelProfile:
    try:
        return _MODEL_BY_ID[model_id]
    except KeyError as exc:
        raise UnsupportedModelError(f"不支持的模型：{model_id}") from exc
