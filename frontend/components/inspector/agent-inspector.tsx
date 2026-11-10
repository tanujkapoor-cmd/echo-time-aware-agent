import { ChevronDown, PanelRight } from "lucide-react";
import { formatTimestamp, webLink } from "../../lib/presentation";
import type { ChatReply, Citation, Claim } from "../../lib/types";

function yesNo(value?: boolean) {
  return typeof value === "boolean" ? (value ? "Yes" : "No") : "Not available";
}

function humanize(value?: string) {
  return typeof value === "string" && value ? value.replaceAll("_", " ") : "Not available";
}

function Source({ source }: { source: Citation }) {
  const url = webLink(source.url);
  return (
    <li className="rounded-lg border border-neutral-200 bg-white p-3 text-xs leading-relaxed">
      <p className="font-semibold wrap-anywhere">[{source.id}] {source.title}</p>
      {url && <a href={url} target="_blank" rel="noreferrer noopener"
        className="mt-1 block text-indigo-800 wrap-anywhere hover:underline">{source.url}</a>}
      <p className="mt-2 text-neutral-600">
        <span className="capitalize">{source.provenance}</span> · Retrieved {formatTimestamp(source.retrieved_at)}
      </p>
      {source.published_at && <p className="text-neutral-600">Published {formatTimestamp(source.published_at)}</p>}
      <blockquote className="mt-2 border-l-2 border-neutral-200 pl-2 text-neutral-700 wrap-anywhere">
        {source.quote}
      </blockquote>
    </li>
  );
}

function values(claims: Claim[]) {
  return [...new Set(claims.map(claim => claim.value))].join(", ") || "Not available";
}

export function AgentInspector({ reply, initiallyOpen }: { reply?: ChatReply; initiallyOpen?: boolean }) {
  return (
    <details open={initiallyOpen} className="group min-w-0 text-sm">
      <summary className="flex min-h-11 list-none items-center gap-2 px-4 py-3 font-semibold lg:min-h-16">
        <PanelRight className="size-4 text-indigo-700" aria-hidden="true" />
        Agent Inspector
        <ChevronDown className="ml-auto size-4 text-neutral-600 group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-5 border-t border-neutral-200 p-4">
        {!reply ? <p className="text-neutral-600">Send a message or select a saved reply to view its execution data.</p> : (
          <>
            <div>
              <p className="mb-2 text-xs text-neutral-600">Reply from {formatTimestamp(reply.timestamp)}</p>
              <dl className="space-y-2 text-xs">
                {[
                  ["Web search used", yesNo(reply.web_search_used)],
                  ["Memory used", yesNo(reply.memory_used)],
                  ["Response latency", typeof reply.elapsed_ms === "number" ? reply.elapsed_ms.toFixed(1) + " ms" : "Not available"],
                  ["Search calls", reply.timing?.search_calls ?? "Not available"],
                  ["Search status", humanize(reply.search_status)],
                  ["Evidence mode", humanize(reply.evidence_mode)],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-2">
                    <dt className="text-neutral-600">{label}</dt>
                    <dd className="text-right font-medium wrap-anywhere">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <h2 className="font-semibold">Sources</h2>
              {reply.citations?.length ? (
                <ul className="mt-2 space-y-2">
                  {reply.citations.map((source, index) => <Source key={source.id + index} source={source} />)}
                </ul>
              ) : <p className="mt-1 text-xs text-neutral-600">{reply.citations ? "No citations returned." : "Not available"}</p>}
            </div>
            <div>
              <h2 className="font-semibold">Detected changes</h2>
              {reply.baseline_at && <p className="mt-1 text-xs text-neutral-600">Baseline retrieved {formatTimestamp(reply.baseline_at)}</p>}
              {reply.changes?.length ? (
                <ul className="mt-2 space-y-2">
                  {reply.changes.map((change, index) => (
                    <li key={index} className="space-y-1 rounded-lg border border-neutral-200 bg-white p-3 text-xs wrap-anywhere">
                      <p className="font-semibold capitalize">{humanize(change.kind)}</p>
                      {(change.subject || change.attribute) && <p>{[change.subject, change.attribute].filter(Boolean).join(" · ")}</p>}
                      {(change.previous.length > 0 || change.current.length > 0) && (
                        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
                          <dt className="text-neutral-600">Previous</dt><dd>{values(change.previous)}</dd>
                          <dt className="text-neutral-600">Current</dt><dd>{values(change.current)}</dd>
                        </dl>
                      )}
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-1 text-xs text-neutral-600">{reply.changes ? "No changes reported." : "Not available"}</p>}
            </div>
            <div>
              <h2 className="font-semibold">Trace ID</h2>
              <code className="mt-1 block text-xs text-neutral-700 wrap-anywhere">{reply.trace_id ?? "Not available"}</code>
            </div>
            <div>
              <h2 className="font-semibold">Memory references</h2>
              <p className="mt-1 text-xs text-neutral-600">Not available for individual replies.</p>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
