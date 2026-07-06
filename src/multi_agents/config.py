from dataclasses import dataclass

from dotenv import load_dotenv

# Load .env file into environment variables (called once at import time)
load_dotenv()


@dataclass(slots=True)
class AppConfig:
    """Top-level runtime configuration.

    Configuration values can be set via .env file or environment variables.
    The .env file is loaded automatically when this module is imported.
    """

    app_name: str = "multi-agents"
    environment: str = "dev"
    workspace_root: str = "."

    # LLM configuration
    # These can be overridden via .env or environment variables:
    #   DASHSCOPE_API_KEY, LLM_MODEL, LLM_BASE_URL
    llm_api_key: str = ""
    llm_model_name: str = "qwen3.6-plus"
    llm_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
