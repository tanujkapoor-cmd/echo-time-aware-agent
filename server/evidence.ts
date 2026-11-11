import { publicUrl } from "./providers.ts";
import type { ResearchDraft, Witness } from "./providers.ts";
import type { Change, Citation, Claim, PriceScope, SearchHit, Snapshot } from "./types.ts";

function flat(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function normalized(value: string): string { return flat(value).toLowerCase(); }
function literal(text: string, value: string): boolean {
  const escaped = normalized(value).replace(/[.*+?^$\u007b\u007d()|[\]\\]/g, "\\$&");
  return !!escaped && new RegExp("(?<![\\p{L}\\p{N}.])" + escaped + "(?![\\p{L}\\p{N}]|\\.\\d)", "u")
    .test(normalized(text));
}

export function canonical(value: string): string {
  const url = publicUrl(value);
  if (!url) return "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_|^(?:ref|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/+$/, "") + url.search;
}

function sameVendor(first: string, second: string): boolean {
  const a = publicUrl(first)?.hostname.replace(/^www\./, "");
  const b = publicUrl(second)?.hostname.replace(/^www\./, "");
  return Boolean(a && b && (a === b || a.endsWith("." + b) || b.endsWith("." + a)));
}

function scopeKey(scope: PriceScope | null | undefined): string {
  return scope ? [scope.plan, scope.currency, scope.billing, scope.unit, scope.market ?? ""].map(normalized).join("|") : "";
}

function isPrice(attribute: string): boolean { return /\b(price|pricing|cost)\b/i.test(attribute); }

function scopeSupported(scope: PriceScope | null, quote: string): boolean {
  if (!scope || !/^[A-Z]{3}$/.test(scope.currency) || !literal(quote, scope.currency) ||
      !scope.plan.trim() || !literal(quote, scope.plan) ||
      (scope.market && !literal(quote, scope.market))) return false;
  const annual = /\b(?:billed annually|annual(?:ly)? billing|per year|\/\s*yr|yearly|annual(?:ly)?)\b/i;
  const billing = {
    annual,
    monthly: /\b(?:billed monthly|monthly|per month)\b|\/\s*mo\b/i,
    hourly: /\b(?:hourly|per hour)\b|\/\s*h(?:r)?\b/i,
    usage: /\b(?:per request|per GB|per compute hour|usage.based)\b/i,
  };
  const unit = {
    seat: /\b(?:per |\/\s*)(?:user|seat|agent)\b/i,
    project: /\b(?:per |\/\s*)project\b/i,
    instance: /\b(?:per |\/\s*)(?:instance|database)\b/i,
    organization: /\b(?:per |\/\s*)(?:org(?:anization)?|team|workspace)\b/i,
    usage: /\b(?:per request|per GB|per compute hour|usage.based)\b/i,
  };
  return billing[scope.billing].test(quote) && unit[scope.unit].test(quote) &&
    (scope.billing !== "monthly" || !annual.test(quote));
}

function claimKey(claim: Claim): string {
  const attribute = isPrice(claim.attribute) ? "price" : normalized(claim.attribute);
  return [normalized(claim.subject), attribute, scopeKey(claim.scope)].join("\u001f");
}

function comparable(claim: Claim): boolean {
  if (!publicUrl(claim.source_url) || !claim.subject.trim() || !claim.attribute.trim() || !claim.value.trim()) return false;
  if (isPrice(claim.attribute)) return scopeSupported(claim.scope ?? null, claim.quote) &&
    /^(?:(?:[A-Z]{3}|[$€£])\s*)?\d[\d,]*(?:\.\d+)?(?:\s*[A-Z]{3})?$/.test(claim.value.trim());
  if (/\b(version|lts|stable release)\b/i.test(claim.attribute)) {
    return /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/i.test(claim.value.trim());
  }
  return true;
}

function cite(source: SearchHit, quote: string, id: string, provenance: Citation["provenance"]): Citation {
  const { snippet: _snippet, ...fields } = source;
  return { ...fields, id, quote: flat(quote), provenance };
}

export function ground(draft: ResearchDraft, sources: SearchHit[], cached: boolean) {
  const accepted = new Map<string, Citation>();
  const claims: Claim[] = [];
  function accept(witness: Witness): SearchHit | undefined {
    const match = /^R([1-9]\d*)$/.exec(witness.source_id);
    const hit = match ? sources[Number(match[1]) - 1] : undefined;
    const quote = flat(witness.quote);
    if (!hit || quote.length < 18 || quote.length > 520 || !publicUrl(hit.url) ||
        !flat(hit.snippet).includes(quote) ||
        /https?:\/\/|\[(?:S|H)\d+\]|ignore .{0,40}instructions|system prompt|tool call|print\s+42|<\s*\/?[a-z]/i.test(quote)) return;
    const key = canonical(hit.url) + "\n" + quote;
    if (!accepted.has(key)) accepted.set(key, cite(hit, quote, "S" + (accepted.size + 1), cached ? "cached" : "live"));
    return hit;
  }
  for (const fact of draft.facts.slice(0, 16)) {
    if (fact.subject.length > 80 || fact.attribute.length > 100 || fact.value.length > 100 ||
        !literal(fact.witness.quote, fact.subject) || !literal(fact.witness.quote, fact.value)) continue;
    const hit = accept(fact.witness);
    if (!hit) continue;
    const claim: Claim = {
      subject: fact.subject.trim(), attribute: fact.attribute.trim(), value: fact.value.trim(),
      quote: flat(fact.witness.quote), source_url: hit.url, observed_at: hit.retrieved_at, scope: fact.scope,
    };
    if (comparable(claim)) claims.push(claim);
  }
  for (const excerpt of draft.excerpts.slice(0, 10)) accept(excerpt);
  return { citations: [...accepted.values()], claims };
}

function displayValue(claim: Claim): string {
  const value = normalized(claim.value).replace(/^v(?=\d)/, "").replace(/(?<=\d),(?=\d{3}\b)/g, "");
  return claim.scope ? value.replace(/(?:^[a-z]{3}\s*|^[$€£]\s*|\s*[a-z]{3}$)/g, "")
    .replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : value;
}

function group(claims: Claim[]): Map<string, Claim[]> {
  const grouped = new Map<string, Claim[]>();
  for (const claim of claims.filter(comparable)) {
    const key = claimKey(claim);
    const existing = grouped.get(key) ?? [];
    if (!existing.some(item => displayValue(item) === displayValue(claim) && canonical(item.source_url) === canonical(claim.source_url))) {
      grouped.set(key, [...existing, claim]);
    }
  }
  return grouped;
}

function onSamePage(claim: Claim, hit: SearchHit): boolean {
  return canonical(claim.source_url) === canonical(hit.url);
}

export function compare(baseline: Snapshot | undefined, current: Claim[], sources: SearchHit[], since?: string): Change[] {
  const earlier = group(baseline?.claims ?? []);
  const now = group(current);
  const changes: Change[] = [];
  for (const key of new Set([...earlier.keys(), ...now.keys()])) {
    const previous = earlier.get(key) ?? [];
    const fresh = [...(now.get(key) ?? [])];
    const sample = previous[0] ?? fresh[0];
    // If the model missed a competing value, a verbatim occurrence in a separate fresh result still counts.
    for (const old of previous) {
      for (const hit of sources) {
        if (fresh.length && fresh.every(item => displayValue(item) !== displayValue(old)) &&
            !onSamePage(fresh[0], hit) && flat(hit.snippet).includes(flat(old.quote))) {
          fresh.push({ ...old, source_url: hit.url, observed_at: hit.retrieved_at });
        }
      }
    }
    const before = new Set(previous.map(displayValue));
    const after = new Set(fresh.map(displayValue));
    let kind: Change["kind"] = "insufficient";
    if (after.size > 1 || (after.size && before.size > 1)) kind = "conflicting";
    else if (!after.size) kind = "now_unverified";
    else if (!before.size) {
      const hit = sources.find(item => onSamePage(fresh[0], item));
      const sinceTime = since ?? baseline?.asked_at;
      if (sinceTime && hit?.published_at && hit.published_at > sinceTime && !sample.scope &&
          baseline?.sources.some(old => sameVendor(old.url, hit.url))) kind = "new";
    } else {
      const pair = fresh.flatMap(observed => previous.filter(old => canonical(old.source_url) === canonical(observed.source_url))
        .map(old => ({ old, observed }))).at(0);
      if (pair && before.has(displayValue(pair.observed))) kind = "unchanged";
      else if (pair) {
        const priorPage = baseline?.sources.filter(hit => onSamePage(pair.old, hit)) ?? [];
        const currentPage = sources.filter(hit => onSamePage(pair.observed, hit));
        if (Date.parse(pair.observed.observed_at) > Date.parse(pair.old.observed_at) &&
            priorPage.some(hit => flat(hit.snippet).includes(flat(pair.old.quote))) &&
            currentPage.some(hit => flat(hit.snippet).includes(flat(pair.observed.quote))) &&
            priorPage.every(hit => !literal(hit.snippet, pair.observed.value)) &&
            currentPage.every(hit => !literal(hit.snippet, pair.old.value))) kind = "changed";
      }
    }
    changes.push({ subject: sample.subject, attribute: sample.attribute, kind, previous, current: fresh });
  }
  return changes.length ? changes : [{ kind: "insufficient", previous: [], current: [] }];
}

export function historicalCitations(citations: Citation[]): Citation[] {
  return citations.filter(item => publicUrl(item.url)).slice(0, 16).map((item, index) => ({
    ...item, id: "H" + (index + 1), provenance: "historical",
  }));
}

export function citeComparison(changes: Change[], citations: Citation[], baseline: Snapshot | undefined, sources: SearchHit[]) {
  const output = [...citations];
  for (const change of changes) {
    for (const [claims, evidence, provenance] of [
      [change.previous, baseline?.sources ?? [], "historical"],
      [change.current, sources, "live"],
    ] as const) {
      for (const claim of claims) {
        if (output.some(item => item.url === claim.source_url && item.quote === claim.quote && item.provenance === provenance)) continue;
        const hit = evidence.find(item => item.url === claim.source_url && flat(item.snippet).includes(claim.quote));
        const historical = provenance === "historical";
        if (hit) output.push(cite(hit, claim.quote, (historical ? "H" : "S") +
          (1 + output.filter(item => item.provenance === provenance).length), provenance));
      }
    }
  }
  return output;
}

function label(claim: Claim | undefined, fallback: string): string {
  if (!claim?.scope) return fallback;
  const { plan, currency, billing, unit, market } = claim.scope;
  return plan + " (" + currency + ", " + billing + ", per " + unit + (market ? ", " + market : "") + ")";
}

export function summarizeComparison(changes: Change[], citations: Citation[]): string {
  return changes.map(change => {
    const previous = change.previous[0];
    const current = change.current[0];
    if (!change.subject) return "I couldn’t verify a change from the evidence I found.";
    const item = change.subject + " " + label(current ?? previous, change.attribute ?? "");
    const refs = [...new Set([...change.previous, ...change.current].flatMap(claim =>
      citations.filter(citation => citation.url === claim.source_url && citation.quote === claim.quote &&
        citation.retrieved_at === claim.observed_at).map(citation => "[" + citation.id + "]")))];
    let sentence: string;
    switch (change.kind) {
      case "changed": sentence = item + " changed from " + previous.value + " to " + current.value + "."; break;
      case "unchanged": sentence = item + " still shows " + current.value + "."; break;
      case "new": sentence = item + ": " + current.quote; break;
      case "conflicting": sentence = "Sources disagree about " + item + ", so I couldn’t verify a change."; break;
      case "now_unverified": sentence = "I couldn’t verify the earlier " + item + " (" + previous.value + ")."; break;
      default: sentence = previous ? "I couldn’t verify a like-for-like change for " + item + "."
        : "I found " + current.value + " for " + item + " but have no comparable earlier evidence.";
    }
    return "- " + sentence + (refs.length ? " " + refs.join(" ") : "");
  }).join("\n");
}

export function renderCitations(citations: Citation[]): string {
  return citations.filter(item => item.provenance !== "historical").map(item => {
    const release = /^(?:\d+\.\s*)?([A-Z][\w +.-]*? \d+(?:\.\d+)+)\s*(?:[-–]\s*)?([A-Z][a-z]+\.? \d{1,2}, \d{4})\s*Download\s*Release notes$/i.exec(item.quote);
    const id = " [" + item.id + "]";
    if (release) return (publicUrl(item.url)?.hostname.replace(/^www\./, "") ?? item.title) +
      " lists " + release[1] + " dated " + release[2] + id + ".";
    return "“" + item.quote + "”" + id;
  }).join("\n\n");
}
