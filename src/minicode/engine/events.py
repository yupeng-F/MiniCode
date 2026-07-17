from __future__ import annotations

from collections.abc import Callable

from minicode.schemas.event import Event

EventSink = Callable[[Event], None]


def null_sink(event: Event) -> None:
    _ = event
