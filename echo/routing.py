import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum


class Route(StrEnum):
    GENERAL = "general"
    FRESH = "fresh"
    FOLLOWUP = "followup"
    HISTORY = "history"
    COMPARE = "compare"


class Volatility(StrEnum):
    NEWS = "news"
    MARKET = "market"
    RELEASE = "release"
    GENERAL = "general"


_NOW = re.compile(
    r"\b(latest|current(?:ly)?|today|right now|as of now|most recent|up.to.date|this week)\b", re.I
)
_COMPARE = re.compile(
    r"\b(has (?:anything|it|that|this) changed|did (?:anything|it|that|this) change|"
    r"what(?:'s| has)? changed|"
    r"still (?:accurate|true|current|valid|available|the latest|the same)|"
    r"since (?:we|i) (?:last )?(?:asked|checked|talked)|"
    r"since (?:last time|then)|compare .{0,70}(?:earlier|previous|last time))\b",
    re.I,
)
_HISTORY = re.compile(
    r"\b(what (?:did|had) (?:you|i|we) (?:say|tell|ask|discuss|decide|find)|"
    r"what (?:was|were) (?:your|my|the|our) (?:previous|earlier|last)|"
    r"remind me what|what did we talk about)\b",
    re.I,
)
_USER_RECALL = re.compile(
    r"\b(what (?:did|had) i (?:say|tell|ask|discuss|decide|find)|"
    r"remind me what i (?:said|asked|told|decided))\b",
    re.I,
)
_REFERENCE = re.compile(
    r"\b(it|that|those|this|they|them|same one|previous|earlier|"
    r"last time|last week|last month|yesterday|we discussed|my|our)\b",
    re.I,
)
_CONTINUATION = re.compile(
    r"^(?:and\b|also\b|what about\b|how about\b|why\b|when\b|tell me more\b|can you elaborate\b)",
    re.I,
)
_LOOKUP = re.compile(
    r"\b(search (?:the )?web|look (?:it|that|this) up|look up|verify online)\b", re.I
)
_NEWS = re.compile(r"\b(news|headlines|breaking|weather|forecast|score|standings|election)\b", re.I)
_MARKET = re.compile(
    r"\b(price|pricing|stock quote|exchange rate|costs?|availability|in stock)\b", re.I
)
_RELEASE = re.compile(r"\b(version|release|changelog|released|security advisory)\b", re.I)
_LIVE_ROLE = re.compile(
    r"\b(who runs|ceo of|president of|prime minister of|who is .{0,50} mayor)\b", re.I
)
_CONCEPT = re.compile(
    r"^(?:define\b|what (?:does .+ mean|is a |is an )|explain\b|how does\b)", re.I
)
_PERSONAL_LOOKUP = re.compile(
    r"\bmy (?:goals?|preferences?|projects?|plans?|interviews?|appointments?|"
    r"deadlines?|commitments?|favorite|schedule|flight|meeting)\b",
    re.I,
)
_SELF_REPORT = re.compile(
    r"^(?:i (?:am|will|want|prefer|like|love|dislike|plan|need|have|changed|decided)|"
    r"i(?:'m|'ll|'ve|'d like)\b|my\b|our\b|actually\b|correction\b|instead\b|"
    r"update\s*:|remember (?:that|my)\b|we (?:are|plan|will|decided)\b)",
    re.I,
)
_ASKING = re.compile(
    r"^(?:i (?:want|need|would like) to (?:know|find out|check|verify|look up)|"
    r"my question is)\b",
    re.I,
)

_STOP = frozenset(
    """
    a an the i we you my our me your to of for in on is are was were be been had did
    do does has have about tell asked ask checked answer question said say it that
    this those they them since last previous earlier latest newest current currently
    stable version release changed change anything what which who how when why
    much today now right still accurate true up date week weeks month months yesterday
    time before after search web look verify again compare most recent and or with
    still valid same as newest its available availability update updates could please
    accurate accuracy true against tell remind find discuss decide talked
    """.split()
)


def terms(text: str) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            word
            for word in re.findall(r"[^\W_]+", text.casefold())
            if word not in _STOP and len(word) > 1
        )
    )


def topic_key(query: str) -> str:
    return (" ".join(terms(query)) or " ".join(query.casefold().split()))[:180]


def has_subject(query: str) -> bool:
    attributes = {"price", "pricing", "cost", "news", "rate", "support", "status"}
    return bool(set(terms(query)) - attributes)


def personal_statement(text: str) -> bool:
    return (
        bool(_SELF_REPORT.search(text))
        and not _ASKING.search(text)
        and not text.rstrip().endswith("?")
    )


def volatility(text: str) -> Volatility:
    if _NEWS.search(text):
        return Volatility.NEWS
    if _MARKET.search(text):
        return Volatility.MARKET
    if _RELEASE.search(text):
        return Volatility.RELEASE
    return Volatility.GENERAL


@dataclass(frozen=True)
class Decision:
    route: Route
    volatility: Volatility
    force_fresh: bool = False
    refers_back: bool = False

    @property
    def needs_search(self) -> bool:
        return self.route in {Route.FRESH, Route.COMPARE}


def decide(text: str) -> Decision:
    group = volatility(text)
    reference = bool(_REFERENCE.search(text) or _CONTINUATION.search(text))
    if personal_statement(text):
        return Decision(
            Route.FOLLOWUP if reference else Route.GENERAL, group, refers_back=reference
        )
    if _COMPARE.search(text) and not _PERSONAL_LOOKUP.search(text):
        return Decision(Route.COMPARE, group, force_fresh=True, refers_back=True)
    if _HISTORY.search(text):
        return Decision(Route.HISTORY, group, refers_back=True)
    if _PERSONAL_LOOKUP.search(text):
        return Decision(Route.FOLLOWUP, group, refers_back=True)
    if _NOW.search(text) or _LOOKUP.search(text):
        return Decision(
            Route.FRESH, group, force_fresh=True, refers_back=reference or not has_subject(text)
        )
    if not _CONCEPT.search(text) and (group != Volatility.GENERAL or _LIVE_ROLE.search(text)):
        return Decision(Route.FRESH, group, refers_back=reference or not has_subject(text))
    if reference:
        return Decision(Route.FOLLOWUP, group, refers_back=True)
    return Decision(Route.GENERAL, group)


def historical_window(text: str, now: datetime) -> tuple[datetime, datetime] | None:
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if re.search(r"\blast week\b", text, re.I):
        monday = midnight - timedelta(days=midnight.weekday())
        return monday - timedelta(days=7), monday
    if re.search(r"\blast month\b", text, re.I):
        first = midnight.replace(day=1)
        return (first - timedelta(days=1)).replace(day=1), first
    if re.search(r"\byesterday\b", text, re.I):
        return midnight - timedelta(days=1), midnight
    if match := re.search(r"\b(\d{1,3}) days? ago\b", text, re.I):
        day = midnight - timedelta(days=int(match[1]))
        return day, day + timedelta(days=1)
    return None


def recalls_user_words(text: str) -> bool:
    return bool(_USER_RECALL.search(text))
