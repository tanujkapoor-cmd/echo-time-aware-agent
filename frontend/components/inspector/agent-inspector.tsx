import { Activity, ArrowUpRight, Clock3, Fingerprint, Globe2, History, Layers, Link2, PanelRightClose, X } from "lucide-react";
import { useState } from "react";
import { formatTimestamp, webLink } from "../../lib/presentation";
import type { ChatReply, Citation } from "../../lib/types";
import { CopyButton } from "../workspace/copy-button";
import { Disclosure } from "../workspace/disclosure";
import { MemoryPanel } from "./memory-panel";
import { TemporalComparison } from "./temporal-comparison";

function used(value?: boolean) {
  return typeof value === "boolean" ? (value ? "Used" : "Not used") : "Not available";
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function Source({ source }: { source: Citation }) {
  const url = webLink(source.url);
  return (
    <li className="inspector-source">
      <div className="source-meta">
        <span className="source-id">{source.id}</span>
        <span>{source.provenance}</span>
      </div>
      {url ? (
        <>
          <a className="source-title" href={url} target="_blank" rel="noreferrer noopener" title={source.url}>
            <span>{source.title}</span><ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <p className="source-host">{new URL(url).hostname}</p>
        </>
      ) : <p className="source-title">{source.title}</p>}
      <p className="source-time">
        Retrieved <time dateTime={source.retrieved_at}>{formatTimestamp(source.retrieved_at)}</time>
      </p>
      <Disclosure label="Source excerpt">
        {source.published_at && <p className="source-time">Published {formatTimestamp(source.published_at)}</p>}
        <blockquote>{source.quote}</blockquote>
      </Disclosure>
    </li>
  );
}

export function AgentInspector({ reply, onClose, drawer, visible }: {
  reply?: ChatReply;
  onClose: () => void;
  drawer?: boolean;
  visible: boolean;
}) {
  const [view, setView] = useState<"activity" | "memory">("activity");
  return (
    <div className="inspector-panel">
      <header className="inspector-head">
        <div className="inspector-brand">
          <span className="inspector-glyph"><Activity size={17} aria-hidden="true" /></span>
          <div><p className="eyebrow">Execution details</p><h2>Agent Inspector</h2></div>
        </div>
        <button type="button" className="icon-button" onClick={onClose}
          aria-label={drawer ? "Close Agent Inspector" : "Collapse Agent Inspector"}>
          {drawer ? <X size={18} aria-hidden="true" /> : <PanelRightClose size={17} aria-hidden="true" />}
        </button>
      </header>
      <div className="inspector-tabs" role="group" aria-label="Inspector view">
        <button type="button" aria-pressed={view === "activity"} onClick={() => setView("activity")}>
          <Activity size={14} aria-hidden="true" /> Reply activity
        </button>
        <button type="button" aria-pressed={view === "memory"} onClick={() => setView("memory")}>
          <Layers size={14} aria-hidden="true" /> Saved memory
        </button>
      </div>
      <div className="inspector-content">
        {view === "memory" ? <MemoryPanel replyId={reply?.message_id} visible={visible} /> : (
          <div className="inspector-view" key={reply?.message_id}><ReplyActivity reply={reply} /></div>
        )}
      </div>
    </div>
  );
}

function ReplyActivity({ reply }: { reply?: ChatReply }) {
  return !reply ? (
    <>
      <div className="inspector-empty">
        <div className="signal-emblem" aria-hidden="true"><Activity size={26} /></div>
        <h3>No reply selected</h3>
        <p>Send a message or inspect a saved reply to see how Echo answered.</p>
      </div>
      <ul className="inspector-guide" aria-label="Inspector sections">
        <li><Globe2 size={16} aria-hidden="true" /><span><strong>Web search</strong><small>Search calls and supporting sources</small></span></li>
        <li><Layers size={16} aria-hidden="true" /><span><strong>Memory</strong><small>Whether Echo used saved context</small></span></li>
        <li><History size={16} aria-hidden="true" /><span><strong>Temporal comparison</strong><small>Previous and current evidence</small></span></li>
      </ul>
    </>
    ) : (
    <>
      <div className="inspector-section-label eyebrow">Selected reply</div>
      <p className="inspector-date"><Clock3 size={13} aria-hidden="true" /> <time dateTime={reply.timestamp}>{formatTimestamp(reply.timestamp)}</time></p>
      <dl className="inspector-metrics">
        <div>
          <dt><Globe2 size={15} aria-hidden="true" /> Web search</dt>
          <dd data-highlight={reply.web_search_used || undefined}>{used(reply.web_search_used)}</dd>
        </div>
        {typeof reply.timing?.search_calls === "number" && <div className="metric-detail">
          <dt>Search calls</dt><dd>{reply.timing.search_calls}</dd>
        </div>}
        <div>
          <dt><Layers size={15} aria-hidden="true" /> Memory</dt>
          <dd data-highlight={reply.memory_used || undefined}>{used(reply.memory_used)}</dd>
        </div>
        {reply.memory_used && <div className="metric-detail">
          <dt>Memory references</dt><dd>Not available</dd>
        </div>}
        {typeof reply.elapsed_ms === "number" && <div>
          <dt><Clock3 size={15} aria-hidden="true" /> Response time</dt>
          <dd>{reply.elapsed_ms < 1000 ? reply.elapsed_ms.toFixed(0) + " ms" : (reply.elapsed_ms / 1000).toFixed(2) + " s"}</dd>
        </div>}
      </dl>
      {(reply.evidence_mode || reply.search_status) && (
        <div className="inspector-tags">
          {reply.evidence_mode && <span>Evidence · {humanize(reply.evidence_mode)}</span>}
          {reply.search_status && <span>Search · {humanize(reply.search_status)}</span>}
        </div>
      )}
      {!!reply.changes?.length && <TemporalComparison changes={reply.changes} baseline={reply.baseline_at} />}
      {reply.citations && <section className="inspector-section">
        <h3><Link2 size={15} aria-hidden="true" /> Sources <span className="count-tag">{reply.citations.length}</span></h3>
        {reply.citations.length
          ? <ul className="inspector-sources">{reply.citations.map((source, index) => <Source key={source.id + index} source={source} />)}</ul>
          : <p className="inspector-empty-line">No citations returned.</p>}
      </section>}
      {reply.trace_id && <section className="inspector-section">
        <h3><Fingerprint size={15} aria-hidden="true" /> Trace ID</h3>
        <div className="trace-row">
          <code title={reply.trace_id}>
            {reply.trace_id.length > 20 ? reply.trace_id.slice(0, 8) + "…" + reply.trace_id.slice(-6) : reply.trace_id}
          </code>
          <CopyButton text={reply.trace_id} label="Copy trace ID" />
        </div>
      </section>}
    </>
  );
}
