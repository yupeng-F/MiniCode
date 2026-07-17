from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any, cast


class ModelMixin:
    def model_dump(self) -> dict[str, Any]:
        return asdict(cast(Any, self))

    def model_dump_json(self) -> str:
        return json.dumps(self.model_dump(), ensure_ascii=False)
