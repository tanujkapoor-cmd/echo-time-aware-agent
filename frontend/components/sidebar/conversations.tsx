import { AudioLines, MessageSquare, Plus } from "lucide-react";
import { formatTimestamp } from "../../lib/presentation";
import type { Session } from "../../lib/types";

interface Props {
  sessions: Session[];
  activeId?: string;
  busy: boolean;
  loading: boolean;
  onNew: () => void;
  onSelect: (session: Session) => void;
}

export function ConversationSidebar(props: Props) {
  return (
    <>
      <aside className="hidden min-h-0 flex-col border-r border-neutral-200 bg-neutral-50 lg:flex">
        <div className="flex min-h-16 items-center gap-3 border-b border-neutral-200 px-5 font-semibold">
          <AudioLines className="size-5 text-indigo-700" aria-hidden="true" /> Echo
        </div>
        <ConversationList {...props} />
      </aside>
      <details className="border-b border-neutral-200 bg-neutral-50 lg:hidden">
        <summary className="flex min-h-11 items-center gap-2 px-4 text-sm font-semibold">
          <AudioLines className="size-4 text-indigo-700" aria-hidden="true" /> Echo <span className="font-normal text-neutral-600">· Conversations</span>
        </summary>
        <div className="flex max-h-[35dvh] min-h-0 flex-col">
          <ConversationList {...props} />
        </div>
      </details>
    </>
  );
}

function ConversationList({ sessions, activeId, busy, loading, onNew, onSelect }: Props) {
  return (
    <>
      <div className="p-3">
        <button type="button" onClick={onNew} disabled={busy}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 text-sm font-semibold hover:border-indigo-600 disabled:opacity-50">
          <Plus className="size-4" aria-hidden="true" /> New Chat
        </button>
      </div>
      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {loading && <p role="status" className="p-2 text-sm text-neutral-600">Loading conversations…</p>}
        {!loading && sessions.length === 0 && <p className="p-2 text-sm text-neutral-600">No conversations yet.</p>}
        <ul className="space-y-1">
          {sessions.map(session => {
            const selected = activeId === session.id;
            return (
              <li key={session.id}>
                <button type="button" aria-current={selected ? "true" : undefined} disabled={busy}
                  onClick={() => onSelect(session)}
                  className={"flex min-h-12 w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left disabled:opacity-60 " +
                    (selected ? "border-indigo-200 bg-indigo-50 text-indigo-900" : "border-transparent hover:bg-neutral-100")}>
                  <MessageSquare className="mt-0.5 size-4 shrink-0 text-neutral-600" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{session.title ?? "Untitled conversation"}</span>
                    <time dateTime={session.created_at} className="block truncate text-xs text-neutral-600">
                      {formatTimestamp(session.created_at)}
                    </time>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
