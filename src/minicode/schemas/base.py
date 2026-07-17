from __future__ import annotations

import json
from dataclasses import asdict


class ModelMixin:
    def model_dump(self) -> dict:
        return asdict(self)

    def model_dump_json(self) -> str:
        return json.dumps(self.model_dump(), ensure_ascii=False)
