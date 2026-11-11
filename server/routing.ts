import { Temporal } from "@js-temporal/polyfill";

const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthPattern = months.map(month => month.length > 3 ? month.slice(0, 3) + "(?:" + month.slice(3) + ")?" : month).join("|");

export function timezone(value?: string): string {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value ?? "UTC" }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

export function historicalWindow(message: string, now: Date, zone: string): [string, string] | null {
  const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(zone).toPlainDate();
  const input = message.toLowerCase();
  const dayFirst = new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + monthPattern + ")(?:\\s+(\\d{4}))?\\b").exec(input);
  const monthFirst = new RegExp("\\b(" + monthPattern + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b").exec(input);
  let day: Temporal.PlainDate;
  let days = 1;

  if (dayFirst || monthFirst) {
    const dayNumber = Number(dayFirst?.[1] ?? monthFirst?.[2]);
    const monthName = (dayFirst?.[2] ?? monthFirst?.[1] ?? "").slice(0, 3);
    const month = months.findIndex(item => item.startsWith(monthName)) + 1;
    const year = dayFirst?.[3] ?? monthFirst?.[3];
    try {
      day = Temporal.PlainDate.from({ year: Number(year ?? today.year), month, day: dayNumber }, { overflow: "reject" });
      if (!year && Temporal.PlainDate.compare(day, today) > 0) day = day.subtract({ years: 1 });
    } catch {
      return null;
    }
  } else if (/\blast week\b/.test(input)) {
    day = today.subtract({ days: today.dayOfWeek + 6 });
    days = 7;
  } else if (/\blast month\b/.test(input)) {
    day = today.with({ day: 1 }).subtract({ months: 1 });
    days = day.daysInMonth;
  } else if (/\byesterday\b/.test(input)) {
    day = today.subtract({ days: 1 });
  } else {
    const ago = /\b(\d{1,3}) days? ago\b/.exec(input);
    const weekday = /\b(last|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(input);
    if (ago) day = today.subtract({ days: Number(ago[1]) });
    else if (weekday) {
      const requested = weekdays.indexOf(weekday[2]) + 1;
      const delta = (today.dayOfWeek - requested + 7) % 7;
      day = today.subtract({ days: delta || (weekday[1] === "last" ? 7 : 0) });
    } else if (/\btoday\b/.test(input) && !/\bstill .{0,24}today\b/.test(input)) day = today;
    else return null;
  }

  const utc = (date: Temporal.PlainDate) =>
    new Date(date.toZonedDateTime(zone).epochMilliseconds).toISOString();
  return [utc(day), utc(day.add({ days }))];
}

const stop = new Set((
  "about asked ask checked change changed changes changing correct accurate supported answer today which what what is was " +
  "last on in for from been had did can could would should might does how where when why with than this that these those " +
  "the they and or of are you your my we me us has have their them since earlier previous options one its still latest stable " +
  "new current now before anymore pricing prices price cost costs release releases version recent recommend anything " +
  "november january february march april may june july august september october december monday tuesday wednesday thursday " +
  "friday saturday sunday please big something shipped web search check verify our again find right true valid any about talk talked say said tell told"
).split(" "));

export function terms(message: string): string[] {
  return [...new Set(message.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(word => word.length > 1 && /\p{L}/u.test(word) && !stop.has(word));
}

export function overlap(message: string, other: string): number {
  const available = new Set(terms(other));
  return terms(message).filter(word => available.has(word)).length;
}

const history = /\b(what (?:did|had) (?:you|i|we) (?:say|tell|ask|discuss|decide|find|talk)|what (?:was|were) (?:your|my|the|our) (?:previous|earlier|last)|remind me what)\b/i;
const compare = /\b((?:has|have|did) .{0,65}(?:changed|change|shipped) (?:since|pricing)|(?:has|did) (?:anything|it|that|this) change(?:d)?|what(?:'s| has)? changed|still (?:accurate|correct|true|current|valid|available|the latest|the same)|since (?:we|i) (?:last )?(?:asked|checked|talked)|since (?:last time|then)|compare .{0,70}(?:earlier|previous|last time))\b/i;
const explicitSearch = /\b(search (?:the )?web|look (?:it |that |this )?up|verify online)\b/i;
const fresh = /\b(latest|current(?:ly)?|today|right now|as of now|most recent|up.to.date|this week|recommend now)\b/i;
const personal = /\bmy (?:goals?|preferences?|projects?|plans?|interviews?|appointments?|deadlines?|schedule|meetings?)\b/i;
const statement = /^(?:i (?:am|will|want|prefer|like|plan|need|have|decided)|i(?:'m|'ll|'ve)\b|my\b|our\b|actually\b|correction\b|update\s*:|remember\b|we (?:are|plan|will|decided)\b)/i;
const news = /\b(news|headlines|weather|forecast|score|standings|election)\b/i;
const market = /\b(pric(?:e|es|ing)|stock quote|exchange rate|costs?|availability|in stock)\b/i;
const release = /\b(versions?|release[ds]?|changelog|security advisory)\b/i;
const concept = /^(?:define\b|what (?:does .+ mean|is a |is an )|explain\b|how does\b)/i;
export const refersBack = /\b(it|that|those|this|they|them|which one|second option|earlier|previous|last time|we discussed)\b/i;

export function canSaveMemory(message: string): boolean {
  return statement.test(message) && !message.endsWith("?") &&
    !/\b(?:need|want) to (?:know|check|find out|look up|verify)\b/i.test(message);
}

export function route(message: string): "chat" | "search" | "history" | "compare" {
  if (canSaveMemory(message) && !explicitSearch.test(message)) return "chat";
  if (compare.test(message) && !personal.test(message)) return "compare";
  if (history.test(message)) return "history";
  if (personal.test(message) && !explicitSearch.test(message)) return "chat";
  if (fresh.test(message) || explicitSearch.test(message) ||
      (!concept.test(message) && (market.test(message) || news.test(message) || release.test(message) ||
        /\b(who runs|ceo of|president of|prime minister of)\b/i.test(message)))) return "search";
  return "chat";
}

export function forceSearch(message: string): boolean {
  return fresh.test(message) || explicitSearch.test(message);
}

export function freshness(message: string): "news" | "market" | "release" | "general" {
  if (news.test(message)) return "news";
  if (market.test(message)) return "market";
  if (release.test(message)) return "release";
  return "general";
}
