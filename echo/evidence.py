import re
from collections import defaultdict
from dataclasses import dataclass
from urllib.parse import urlsplit

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


_RELEASE_ROW = re.compile(
    r"(?:\d+\.\s+)?(?P<release>[A-Z][\w +.-]*? \d+(?:\.\d+)+)"
    r"\s*(?:[-–]\s*)?(?P<date>[A-Z][a-z]+\.? \d{1,2}, \d{4})"
    r"\s*Download\s*Release notes",
    re.IGNORECASE,
)


def _readable_excerpt(citation: Citation) -> str:
    # Tavily can concatenate the cells of a release table. Format the fields
    # we can read directly and leave the original text in the source card.
    row = _RELEASE_ROW.fullmatch(citation.quote)
    host = urlsplit(citation.url).hostname
    if row and host:
        return (
            f"{host.removeprefix('www.')} lists {row['release']} "
            f"dated {row['date']} [{citation.id}]."
        )
    return f"“{citation.quote}” [{citation.id}]"


@dataclass(frozen=True)
class Grounding:
    citations: list[Citation]
    claims: list[Claim]

    def render(self) -> str:
        return "\n\n".join(map(_readable_excerpt, self.citations))


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
        or not _quote_in(witness.quote, source.snippet)
    ):
        return None
    return source


def ground(
    witnesses: list[Witness],
    facts: list[FactDraft],
    sources: dict[str, SearchResult],
    cached: bool,
    *,
    previous: list[Claim] | None = None,
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

    def accept_fact(fact: FactDraft):
        source = _valid_witness(fact.witness, sources)
        if (
            not source
            or not fact.subject.strip()
            or not fact.attribute.strip()
            or not fact.value.strip()
            or not _contains(fact.value, fact.witness.quote)
            or not _contains(fact.subject, fact.witness.quote)
        ):
            return
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

    # Consider comparison evidence first so each accepted claim is visible and citable.
    for fact in facts[:8]:
        accept_fact(fact)

    # Extraction can omit an opposing result. Reuse a known claim only if its
    # exact witness appears in a current result and an extracted claim disagrees.
    for claim in previous or []:
        if len(accepted) >= 8:
            break
        if not 18 <= len(claim.quote) <= 460:
            continue
        if not any(
            _claim_key(candidate) == _claim_key(claim)
            and normalized(candidate.value) != normalized(claim.value)
            for candidate in claims
        ):
            continue
        for source_id, source in sources.items():
            if len(accepted) >= 8:
                break
            if _quote_in(claim.quote, source.snippet) and not any(
                _claim_key(candidate) == _claim_key(claim)
                and normalized(candidate.value) == normalized(claim.value)
                and candidate.source_url == source.url
                for candidate in claims
            ):
                witness = Witness(source_id=source_id, quote=claim.quote)
                accept_fact(
                    FactDraft(
                        subject=claim.subject,
                        attribute=claim.attribute,
                        value=claim.value,
                        witness=witness,
                    )
                )
    for witness in witnesses[:5]:
        if len(accepted) >= 8:
            break
        if source := _valid_witness(witness, sources):
            cite(witness, source)
    return Grounding(list(accepted.values()), claims)


def _quote_in(quote: str, snippet: str) -> bool:
    return " ".join(quote.split()) in " ".join(snippet.split())


def _claim_key(claim: Claim) -> tuple[str, str]:
    return normalized(claim.subject), normalized(claim.attribute)


def _group(claims: list[Claim]):
    result = defaultdict(dict)
    for claim in claims:
        key = _claim_key(claim)
        result[key][(normalized(claim.value), claim.source_url)] = claim
    return {key: list(group.values()) for key, group in result.items()}


def compare(
    previous: list[Claim], current: list[Claim], *, earlier_snippets: dict[str, str] | None = None
) -> list[Change]:
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
        elif earlier_snippets and all(
            _quote_in(item.quote, earlier_snippets.get(item.source_url, "")) for item in present
        ):
            kind = ChangeKind.INSUFFICIENT
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
    if any(item.kind == ChangeKind.INSUFFICIENT and not item.previous for item in changes):
        lines.append("I couldn’t verify whether the earlier answer changed.")
    for item in changes:
        if item.kind == ChangeKind.INSUFFICIENT and not item.previous:
            continue
        label = f"the reported {item.attribute} for {item.subject}"
        if item.kind == ChangeKind.CHANGED:
            line = f"The reported {item.attribute} for {item.subject} changed from {item.previous[0].value} to {item.current[0].value}."
        elif item.kind == ChangeKind.UNCHANGED:
            line = f"The sources still report {item.current[0].value} for {item.subject} ({item.attribute})."
        elif item.kind == ChangeKind.NEW:
            line = f"The sources report {item.current[0].value} for {item.subject} ({item.attribute}). I don’t have an earlier value to compare."
        elif item.kind == ChangeKind.NOW_UNVERIFIED:
            line = f"I couldn’t verify {label} in this check."
        elif item.kind == ChangeKind.INSUFFICIENT:
            line = f"The earlier search already contained the current quote, so I can’t verify a change in {label}."
        else:
            line = f"The excerpts disagree about {label}, so I can’t confirm a single value."
        refs = dict.fromkeys(
            labels.get((claim.source_url, claim.quote, historical))
            for historical, claims in ((True, item.previous), (False, item.current))
            for claim in claims
        )
        lines.append(line + "".join(f" [{ref}]" for ref in refs if ref))
    return "\n".join(lines)
