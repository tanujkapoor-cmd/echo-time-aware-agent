"use client";

import { AudioLines, ChevronRight, LoaderCircle, PanelLeft, PanelRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "../../hooks/use-chat";
import type { Session } from "../../lib/types";
import { AgentInspector } from "../inspector/agent-inspector";
import { ConversationSidebar } from "../sidebar/conversations";
import { SideDrawer } from "../workspace/side-drawer";
import { Composer } from "./composer";
import { MessageItem } from "./message-item";
import { Welcome } from "./welcome";

const stageLabels: Record<string, string> = {
  receive_query: "Request received",
  load_context: "Loading context",
  decide_search: "Checking whether search is needed",
  execute_search: "Searching the web",
  generate_answer: "Preparing the answer",
  validate_response: "Validating the answer",
  persist_memory: "Saving the turn",
  complete: "Receiving the answer",
};

export function Chat() {
  const chat = useChat();
  const input = useRef<HTMLTextAreaElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const [inspectedId, setInspectedId] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [drawer, setDrawer] = useState<"conversations" | "inspector">();
  const closeDrawer = useCallback(() => setDrawer(undefined), []);
  const inspected = chat.messages.find(item => item.id === inspectedId)?.response
    ?? chat.messages.findLast(item => item.response)?.response ?? undefined;

  useEffect(() => {
    const view = transcript.current;
    if (view && followBottom.current) view.scrollTop = view.scrollHeight;
  }, [chat.messages, chat.pending, chat.preview]);

  function openConversation(session?: Session) {
    followBottom.current = true;
    setInspectedId(undefined);
    closeDrawer();
    void chat.openConversation(session);
  }

  function inspect(messageId: string) {
    setInspectedId(messageId);
    if (window.matchMedia("(min-width: 1200px)").matches) setInspectorOpen(true);
    else setDrawer("inspector");
  }

  const sidebar = {
    sessions: chat.sessions,
    previews: chat.previews,
    activeId: chat.session?.id,
    busy: chat.busy,
    loading: chat.loading,
    onNew: () => openConversation(),
    onSelect: openConversation,
  };

  return (
    <div className="echo-app" data-sidebar-open={sidebarOpen} data-inspector-open={inspectorOpen}>
      <aside className="sidebar-shell" id="desktop-conversations"><ConversationSidebar {...sidebar} /></aside>
      <main className="workspace">
        <header className="workspace-bar">
          <div className="workspace-path">
            <button type="button" className="icon-button desktop-conversations-toggle"
              aria-label={sidebarOpen ? "Collapse conversations" : "Expand conversations"}
              aria-expanded={sidebarOpen} aria-controls="desktop-conversations"
              onClick={() => setSidebarOpen(open => !open)}><PanelLeft size={19} aria-hidden="true" /></button>
            <button type="button" className="icon-button mobile-conversations-toggle"
              aria-label="Open conversations" aria-haspopup="dialog"
              onClick={() => setDrawer("conversations")}><PanelLeft size={20} aria-hidden="true" /></button>
            <span className="mobile-echo" aria-hidden="true"><AudioLines size={18} /> Echo</span>
            <span className="workspace-root">Workspace</span><ChevronRight className="workspace-chevron" size={14} aria-hidden="true" />
            <h1>{chat.session?.title ?? (chat.messages.length ? "Untitled conversation" : "New conversation")}</h1>
          </div>
          <button type="button" ref={inspectorToggle} className="inspector-toggle desktop-inspector-toggle"
            aria-expanded={inspectorOpen} aria-controls="desktop-inspector"
            onClick={() => setInspectorOpen(open => !open)}>
            <PanelRight size={16} aria-hidden="true" /> <span>Inspector</span>
          </button>
          <button type="button" className="inspector-toggle mobile-inspector-toggle"
            aria-label="Open Agent Inspector" aria-haspopup="dialog" onClick={() => setDrawer("inspector")}>
            <PanelRight size={18} aria-hidden="true" /> <span>Inspector</span>
          </button>
        </header>
        <div className="transcript" ref={transcript} role="region" aria-label="Conversation messages" tabIndex={0}
          onScroll={event => {
            const view = event.currentTarget;
            followBottom.current = view.scrollHeight - view.clientHeight - view.scrollTop < 80;
          }}>
          <div className="chat-column transcript-column">
            {chat.loading && <p role="status" className="chat-status"><LoaderCircle size={16} aria-hidden="true" /> Loading conversation…</p>}
            {!chat.loading && chat.messages.length === 0 && !chat.pending && (
              <Welcome draft={chat.draft} disabled={chat.busy} onPrompt={prompt => { chat.setDraft(prompt); input.current?.focus(); }} />
            )}
            {chat.messages.map(message => <MessageItem key={message.id} message={message}
              inspect={message.response ? () => inspect(message.id) : undefined}
              inspected={message.response?.message_id === inspected?.message_id} />)}
            {chat.pending && <MessageItem message={chat.pending} />}
            {chat.pending && <p role="status" className="chat-status">
              <LoaderCircle size={16} aria-hidden="true" />
              {chat.stage ? (stageLabels[chat.stage] ?? chat.stage) : "Waiting for Echo…"}
              {chat.sources.length > 0 && <span>· {chat.sources.length} sources received</span>}
            </p>}
            {chat.pending && chat.preview && <p className="stream-preview">{chat.preview}</p>}
          </div>
        </div>
        <Composer input={input} draft={chat.draft} busy={chat.busy} sending={!!chat.pending}
          error={chat.error} canRetry={chat.canRetry} onChange={chat.setDraft} onStop={chat.cancel}
          onSend={() => { followBottom.current = true; setInspectedId(undefined); void chat.send(); }} />
      </main>
      <aside className="inspector-shell" id="desktop-inspector" hidden={!inspectorOpen}>
        <AgentInspector reply={inspected} onClose={() => {
          setInspectorOpen(false);
          inspectorToggle.current?.focus();
        }} />
      </aside>
      <SideDrawer open={drawer === "conversations"} side="left" label="Conversations" desktopAt={960} onClose={closeDrawer}>
        <ConversationSidebar {...sidebar} onClose={closeDrawer} />
      </SideDrawer>
      <SideDrawer open={drawer === "inspector"} side="right" label="Agent Inspector" desktopAt={1200} onClose={closeDrawer}>
        <AgentInspector reply={inspected} onClose={closeDrawer} drawer />
      </SideDrawer>
    </div>
  );
}
