from __future__ import annotations

from minicode.schemas.session import SessionState


def enter_plan_mode(session: SessionState) -> SessionState:
    session.mode = "plan"
    return session


def exit_plan_mode(session: SessionState) -> SessionState:
    session.mode = "act"
    return session
