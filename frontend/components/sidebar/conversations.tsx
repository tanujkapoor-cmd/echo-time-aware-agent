import { AudioLines, MessageSquare, Plus, X } from "lucide-react";
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
  onClose?: () => void;
}

export function ConversationSidebar({ sessions, previews, activeId, busy, loading, collapsed, onNew, onSelect, onClose }: Props) {
  return (
    <div className="conversation-sidebar">
      <div className="sidebar-brand">
        <span className="echo-mark"><AudioLines size={20} aria-hidden="true" /></span>
        <span className="brand-name">Echo<span>.</span></span>
        {onClose && <button type="button" className="icon-button ml-auto" aria-label="Close conversations" onClick={onClose}>
          <X size={19} aria-hidden="true" />
        </button>}
      </div>
      <div className="sidebar-actions">
        <button type="button" className="new-chat" onClick={onNew} disabled={busy} aria-label="New Chat">
          <Plus size={17} aria-hidden="true" /> <span>New Chat</span>
        </button>
      </div>
      <nav aria-label="Conversations" className="history-nav" inert={collapsed}>
        <h2 className="eyebrow history-label">Conversations</h2>
        {loading && <p role="status" className="sidebar-empty">Loading conversations…</p>}
        {!loading && !sessions.length && <p className="sidebar-empty">Your conversations will appear here.</p>}
        <ul className="conversation-list">
          {sessions.map(session => (
            <li className="conversation-row" key={session.id}>
              <button
                type="button"
                className="conversation-link"
                aria-current={session.id === activeId ? "true" : undefined}
                disabled={busy}
                onClick={() => onSelect(session)}
              >
                <MessageSquare size={15} className="conversation-icon" aria-hidden="true" />
                <span className="conversation-text">
                  <span className="conversation-title">{session.title ?? "Untitled conversation"}</span>
                  {previews[session.id]
                    ? <span className="conversation-preview" title={previews[session.id]}>{previews[session.id]}</span>
                    : <time className="conversation-preview" dateTime={session.created_at}>{formatTimestamp(session.created_at)}</time>}
                </span>
              </button>
              <ConversationMenu id={session.id} title={session.title ?? "Untitled conversation"}
                disabled={busy} onOpen={() => onSelect(session)} />
            </li>
          ))}
        </ul>
      </nav>
      <div className="sidebar-footer"><span className="signal-dot" aria-hidden="true" /> <span>Research workspace</span></div>
    </div>
  );
}
