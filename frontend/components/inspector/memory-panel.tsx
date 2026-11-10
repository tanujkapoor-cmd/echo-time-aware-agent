import { Layers, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { listMemories } from "../../lib/api";
import { formatTimestamp } from "../../lib/presentation";
import type { SavedMemory } from "../../lib/types";
import { Disclosure } from "../workspace/disclosure";

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

function MemoryCard({ memory }: { memory: SavedMemory }) {
  return (
    <li className="memory-card">
      <div className="memory-meta">
        <span className="eyebrow">{memory.kind}</span>
        <span className="memory-state" data-active={memory.active}>{memory.active ? "Active" : "Superseded"}</span>
      </div>
      <p className="memory-text">{memory.content}</p>
      <Disclosure label="Memory details">
        <dl className="memory-details">
          <div><dt>Observed</dt><dd><time dateTime={memory.observed_at}>{formatTimestamp(memory.observed_at)}</time></dd></div>
          <div><dt>Saved</dt><dd><time dateTime={memory.created_at}>{formatTimestamp(memory.created_at)}</time></dd></div>
          {memory.superseded_at && <div><dt>Superseded</dt><dd><time dateTime={memory.superseded_at}>{formatTimestamp(memory.superseded_at)}</time></dd></div>}
          <div><dt>Source messages</dt><dd>{memory.source_message_ids.length}</dd></div>
        </dl>
      </Disclosure>
    </li>
  );
}

type MemoryResult = { memories: SavedMemory[] } | { error: string };

export function MemoryPanel({ replyId }: { replyId?: string }) {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; result: MemoryResult }>();
  const key = (replyId ?? "") + ":" + revision;
  const pending = loaded?.key !== key;
  const result = loaded?.result;
  const groups = new Map<string, SavedMemory[]>();
  if (result && "memories" in result) {
    for (const memory of result.memories) {
      const day = dayFormat.format(new Date(memory.observed_at));
      const group = groups.get(day);
      if (group) group.push(memory);
      else groups.set(day, [memory]);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void listMemories(controller.signal).then(
      memories => { if (!controller.signal.aborted) setLoaded({ key, result: { memories } }); },
      error => {
        if (!controller.signal.aborted) setLoaded({ key, result: {
          error: error instanceof Error ? error.message : "Could not load saved memory.",
        } });
      },
    );
    return () => controller.abort();
  }, [key]);

  return (
    <section className="memory-panel" aria-label="Saved memory">
      <header className="memory-head">
        <div><p className="eyebrow">Across conversations</p><h3>Memory timeline</h3></div>
        <button type="button" className="icon-button" aria-label="Refresh saved memory" disabled={pending}
          onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} aria-hidden="true" /></button>
      </header>
      <p className="memory-intro">Details Echo saved from your messages, grouped by when you shared them.</p>
      {pending && <p className="memory-status" role="status"><LoaderCircle size={15} aria-hidden="true" /> Loading saved memory…</p>}
      {!pending && result && "error" in result && <p className="memory-status" role="alert">{result.error}</p>}
      {!pending && result && "memories" in result && !groups.size && (
        <div className="inspector-empty"><span className="signal-emblem"><Layers size={24} aria-hidden="true" /></span>
          <h3>No saved memory yet</h3><p>Saved goals, preferences, projects, plans, and commitments will appear here.</p>
        </div>
      )}
      {!!groups.size && <div className="memory-timeline">
        {[...groups].map(([day, memories]) => (
          <section className="memory-day" key={day}>
            <h4>{day}</h4>
            <ul>{memories.map(memory => <MemoryCard key={memory.id} memory={memory} />)}</ul>
          </section>
        ))}
      </div>}
    </section>
  );
}
