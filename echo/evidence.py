import re
from collections import defaultdict
from dataclasses import dataclass

from pydantic import BaseModel, Field

from echo.memory import normalized
from echo.schemas import Change, ChangeKind, Citation, Claim
from echo.search import SearchResult, public_link


class Witness(BaseModel):
    source_id: str
    quote: str = Field(min_length=18, max_length=460)


class FactDraft(BaseModel):
    subject: str = Field(min_length=1, max_length=80)
    attribute: str = Field(min_length=1, max_length=80)
    value: str = Field(min_length=1, max_length=100)
    witness: Witness


@dataclass(frozen=True)
class Grounding:
    citations: list[Citation]
    claims: list[Claim]

    def render(self) -> str:
        return "\n".join(f"“{citation.quote}” [{citation.id}]" for citation in self.citations)


def _contains(value: str, quote: str) -> bool:
    # Word boundaries prevent comparing 3.1 with a source that only says 3.10.
    return bool(
        re.search(r"(?<![\w.])" + re.escape(normalized(value)) + r"(?!\w|\.\d)", normalized(quote))
    )


def _valid_witness(witness: Witness, sources: dict[str, SearchResult]) -> SearchResult | None:
    source = sources.get(witness.source_id)
    if (
        not source
        or not public_link(source.url)
        or not witness.quote.strip()
        or re.search(r"\[(?:S|H)\d+\]", witness.quote, re.I)
        or re.search(r"https?://|www\.", witness.quote, re.I)
        or " ".join(witness.quote.split()) not in " ".join(source.snippet.split())
    ):
        return None
    return source


def ground(
    witnesses: list[Witness], facts: list[FactDraft], sources: dict[str, SearchResult], cached: bool
) -> Grounding:
    accepted: dict[tuple[str, str], Citation] = {}
    claims = []

    def cite(witness: Witness, source: SearchResult):
        key = (witness.source_id, normalized(witness.quote))
        if key not in accepted:
            accepted[key] = Citation(
                id=f"S{len(accepted) + 1}",
                title=source.title,
                url=source.url,
                quote=" ".join(witness.quote.split()),
                published_at=source.published_at,
                retrieved_at=source.retrieved_at,
                provenance="cached" if cached else "live",
            )

    # Consider comparison evidence first so each accepted claim is visible and citable.
    for fact in facts[:8]:
        source = _valid_witness(fact.witness, sources)
        if (
            not source
            or not fact.subject.strip()
            or not fact.attribute.strip()
            or not fact.value.strip()
            or not _contains(fact.value, fact.witness.quote)
            or not _contains(fact.subject, fact.witness.quote)
        ):
            continue
        claims.append(
            Claim(
                subject=fact.subject.strip(),
                attribute=fact.attribute.strip(),
                value=fact.value.strip(),
                observed_at=source.retrieved_at,
                source_url=source.url,
                quote=" ".join(fact.witness.quote.split()),
            )
        )
        cite(fact.witness, source)
    for witness in witnesses[:5]:
        if len(accepted) >= 8:
            break
        if source := _valid_witness(witness, sources):
            cite(witness, source)
    return Grounding(list(accepted.values()), claims)


def _group(claims: list[Claim]):
    result = defaultdict(dict)
    for claim in claims:
        key = (normalized(claim.subject), normalized(claim.attribute))
        result[key][(normalized(claim.value), claim.source_url)] = claim
    return {key: list(group.values()) for key, group in result.items()}


def compare(previous: list[Claim], current: list[Claim]) -> list[Change]:
    old = _group(previous)
    new = _group(current)
    changes = []
    if not old or not new:
        changes.append(Change(kind=ChangeKind.INSUFFICIENT))
    for key in sorted(old.keys() | new.keys()):
        past, present = old.get(key, []), new.get(key, [])
        before = {normalized(item.value) for item in past}
        after = {normalized(item.value) for item in present}
        if len(after) > 1 or (present and len(before) > 1):
            kind = ChangeKind.CONFLICTING
        elif not present:
            kind = ChangeKind.NOW_UNVERIFIED
        elif not past:
            kind = ChangeKind.NEW if old else ChangeKind.INSUFFICIENT
        elif before == after:
            kind = ChangeKind.UNCHANGED
        else:
            kind = ChangeKind.CHANGED
        item = (present or past)[0]
        changes.append(
            Change(
                subject=item.subject,
                attribute=item.attribute,
                kind=kind,
                previous=past,
                current=present,
            )
        )
    if old and new and not (old.keys() & new.keys()):
        changes.insert(0, Change(kind=ChangeKind.INSUFFICIENT))
    return changes


def describe_changes(changes: list[Change], citations: list[Citation]) -> str:
    labels = {
        (citation.url, citation.quote, citation.provenance == "historical"): citation.id
        for citation in citations
    }
    lines = []
    if any(item.kind == ChangeKind.INSUFFICIENT for item in changes):
        lines.append(
            "The evidence is insufficient to determine whether the previous answer changed."
        )
    for item in changes:
        if item.kind == ChangeKind.INSUFFICIENT:
            continue
        label = f"{item.subject} — {item.attribute}"
        if item.kind == ChangeKind.CHANGED:
            line = f"{label}: the reported value changed from {item.previous[0].value} to {item.current[0].value}."
        elif item.kind == ChangeKind.UNCHANGED:
            line = f"{label}: comparable excerpts still report {item.current[0].value}."
        elif item.kind == ChangeKind.NEW:
            line = f"{label}: now reported as {item.current[0].value}; no comparable earlier claim was saved."
        elif item.kind == ChangeKind.NOW_UNVERIFIED:
            line = f"{label}: the earlier claim was not verified in this check."
        else:
            line = f"{label}: excerpts disagree; a single value could not be established."
        refs = dict.fromkeys(
            labels.get((claim.source_url, claim.quote, historical))
            for historical, claims in ((True, item.previous), (False, item.current))
            for claim in claims
        )
        lines.append(line + "".join(f" [{ref}]" for ref in refs if ref))
    return "\n".join(lines)
