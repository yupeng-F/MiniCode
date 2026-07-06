"""User-facing entrypoints."""

from multi_agents.interfaces.cli import main as cli_main
from multi_agents.interfaces.web.server import main as web_main

__all__ = ["cli_main", "web_main"]
