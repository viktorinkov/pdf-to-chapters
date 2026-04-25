from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ChapterEntry(BaseModel):
    title: str = Field(description="Chapter or section title as printed in the book.")
    page_number: int = Field(
        description="Printed page label (NOT physical index) where the chapter starts.",
        ge=1,
    )
    level: Literal[1, 2, 3] = Field(
        description="1 = chapter or part, 2 = section, 3 = sub-section.",
    )


class ChapterList(BaseModel):
    chapters: list[ChapterEntry]
