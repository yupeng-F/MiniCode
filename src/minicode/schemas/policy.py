from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(slots=True)
class RiskProfile:
    reversibility: Literal["reversible", "hard_to_reverse", "irreversible"] = "reversible"
    blast_radius: Literal["none", "file", "workspace", "system", "network"] = "none"
    data_exposure: Literal["none", "local_only", "external"] = "none"
    approval: Literal["never", "on_policy", "always"] = "on_policy"


@dataclass(slots=True)
class PolicyDecision:
    decision: Literal["allow", "allow_with_approval", "deny"]
    reason: str
    matched_rule: str = ""
    requires_approval: bool = False

    def model_dump(self) -> dict:
        return {
            "decision": self.decision,
            "reason": self.reason,
            "matched_rule": self.matched_rule,
            "requires_approval": self.requires_approval,
        }
