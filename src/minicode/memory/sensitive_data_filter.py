from __future__ import annotations

import re


class SensitiveDataFilter:
    """Redacts credentials before they reach prompts or persistent metadata."""

    patterns = [
        re.compile(r"(?i)\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|api_key|token|password)\s*[:=]\s*([^\s'\"`]+)"),
        re.compile(r"(?i)\b(bearer)\s+[a-z0-9._~+/=-]{12,}"),
        re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----"),
        re.compile(r"(?i)([a-z][a-z0-9+.-]*://[^\s/:@]+):([^\s@/]+)@"),
    ]

    def contains_sensitive(self, text: str) -> bool:
        return any(pattern.search(text) for pattern in self.patterns)

    def sanitize(self, text: str) -> str:
        result = text
        for pattern in self.patterns:
            result = pattern.sub(self._replacement, result)
        return result

    @staticmethod
    def _replacement(match: re.Match) -> str:
        label = match.group(1) if match.lastindex else "Sensitive value"
        return f"{label}=Sensitive value redacted"
