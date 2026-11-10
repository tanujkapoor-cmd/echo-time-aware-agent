import { ArrowUpRight, History } from "lucide-react";
import { formatTimestamp, webLink } from "../../lib/presentation";
import type { Change, Claim } from "../../lib/types";

const labels: Record<Change["kind"], string> = {
  changed: "Changed",
  unchanged: "Unchanged",
  new: "New evidence",
  now_unverified: "Now unverified",
  conflicting: "Conflicting evidence",
  insufficient: "Unable to verify",
};

function Evidence({ label, claims }: { label: string; claims: Claim[] }) {
  return (
    <div className="comparison-evidence">
      <p className="eyebrow">{label}</p>
      {!claims.length ? <p className="comparison-missing">Not available</p> : (
        <ul>
          {claims.map((claim, index) => {
            const url = webLink(claim.source_url);
            return (
              <li key={index}>
                <p className="comparison-value">{claim.value}</p>
                <time dateTime={claim.observed_at}>{formatTimestamp(claim.observed_at)}</time>
                {url && <a href={url} target="_blank" rel="noreferrer noopener"
                  aria-label={label + " evidence for " + claim.value}>
                  Evidence <ArrowUpRight size={12} aria-hidden="true" />
                </a>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function TemporalComparison({ changes, baseline }: { changes: Change[]; baseline?: string | null }) {
  return (
    <section className="comparison" aria-label="Temporal comparison">
      <div className="comparison-heading">
        <History size={17} aria-hidden="true" />
        <div>
          <h3>{baseline ? "What changed since last time?" : "Evidence comparison"}</h3>
          {baseline && <p>Baseline retrieved <time dateTime={baseline}>{formatTimestamp(baseline)}</time></p>}
        </div>
      </div>
      <ul className="comparison-list">
        {changes.map((change, index) => (
          <li className="comparison-item" key={index}>
            <p className="comparison-tag" data-kind={change.kind}>{labels[change.kind] ?? change.kind}</p>
            {(change.subject || change.attribute) && (
              <p className="comparison-subject">{[change.subject, change.attribute].filter(Boolean).join(" · ")}</p>
            )}
            {(change.previous.length > 0 || change.current.length > 0) && (
              <div className="comparison-grid">
                <Evidence label="Previous" claims={change.previous} />
                <Evidence label="Current" claims={change.current} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
