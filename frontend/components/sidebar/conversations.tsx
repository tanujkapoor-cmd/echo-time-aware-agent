import { AudioLines, History, Layers, MessageSquare, PanelLeftClose, Plus, Search, X } from "lucide-react";
import { useRef, useState } from "react";
import { formatTimestamp } from "../../lib/presentation";
import type { Session } from "../../lib/types";
import { ConversationMenu } from "./conversation-menu";

interface Props {
  sessions: Session[];
  previews: Record<string, string>;
  activeId?: string;
  busy: boolean;
  loading: boolean;
  collapsed?: boolean;
  onNew: () => void;
  onSelect: (session: Session) => void;
  onMemory: () => void;
  onClose?: () => void;
  onCollapse?: () => void;
}

export function ConversationSidebar({ sessions, previews, activeId, busy, loading, collapsed, onNew, onSelect,
  onMemory, onClose, onCollapse }: Props) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const term = query.trim().toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = { Today: [] as Session[], Yesterday: [] as Session[], Earlier: [] as Session[] };

  for (const session of sessions) {
    if (term && ![session.title ?? "Untitled conversation", previews[session.id]]
      .some(value => value?.toLowerCase().includes(term))) continue;
    const created = new Date(session.created_at);
    groups[created >= today ? "Today" : created >= yesterday ? "Yesterday" : "Earlier"].push(session);
  }

  return (
    <div className="conversation-sidebar">
      <div className="sidebar-brand">
        <span className="echo-mark"><AudioLines size={19} aria-hidden="true" /></span>
        <span className="brand-name">Echo</span>
        {onCollapse && !collapsed && <button type="button" className="icon-button sidebar-collapse"
          aria-label="Collapse conversations" aria-controls="desktop-conversations" aria-expanded onClick={onCollapse}>
          <PanelLeftClose size={19} aria-hidden="true" />
        </button>}
        {onClose && <button type="button" className="icon-button sidebar-collapse" aria-label="Close conversations" onClick={onClose}>
          <X size={19} aria-hidden="true" />
        </button>}
      </div>
      <div className="sidebar-actions">
        <button type="button" className="new-chat" onClick={onNew} disabled={busy} aria-label="New Chat">
          <Plus size={17} aria-hidden="true" /> <span>New Chat</span>
        </button>
      </div>
      <div className="sidebar-tools" inert={collapsed}>
        <label className="history-search">
          <Search size={16} aria-hidden="true" />
          <input ref={search} type="search" aria-label="Search conversations" placeholder="Search conversations"
            value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        <button type="button" onClick={() => search.current?.focus()}><History size={17} aria-hidden="true" /> History</button>
        <button type="button" onClick={onMemory}><Layers size={17} aria-hidden="true" /> Saved memory</button>
      </div>
      <nav aria-label="Conversations" className="history-nav" inert={collapsed}>
        <h2 className="sr-only">Conversations</h2>
        {loading && <p role="status" className="sidebar-empty">Loading conversations…</p>}
        {!loading && !sessions.length && <p className="sidebar-empty">Your conversations will appear here.</p>}
        {!!sessions.length && !!term && Object.values(groups).every(rows => rows.length === 0)
          && <p role="status" className="sidebar-empty">No conversations match your search.</p>}
        {Object.entries(groups).map(([day, rows]) => rows.length > 0 && (
          <section className="history-group" key={day} aria-label={day}>
            <h3 className="history-label">{day}</h3>
            <ul className="conversation-list">
              {rows.map(session => {
                const title = session.title ?? previews[session.id] ?? "Untitled conversation";
                return (
                  <li className="conversation-row" key={session.id}>
                    <button type="button" className="conversation-link" title={title}
                      aria-current={session.id === activeId ? "true" : undefined} disabled={busy}
                      onClick={() => onSelect(session)}>
                      <MessageSquare size={15} className="conversation-icon" aria-hidden="true" />
                      <span className="conversation-text">
                        <span className="conversation-title">{title}</span>
                        {!session.title && !previews[session.id] && <time className="conversation-preview"
                          dateTime={session.created_at}>{formatTimestamp(session.created_at)}</time>}
                      </span>
                    </button>
                    <ConversationMenu id={session.id} title={title} disabled={busy} onOpen={() => onSelect(session)} />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
      <div className="sidebar-footer"><span className="signal-dot" aria-hidden="true" /> <span>Research workspace</span></div>
    </div>
  );
}
