"use client";

import { ArrowDown, AudioLines, ChevronRight, LoaderCircle, PanelLeft, PanelRight } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { answerKey, useChat } from "../../hooks/use-chat";
import { createDraftStore } from "../../lib/draft";
import type { Session } from "../../lib/types";
import { AgentInspector, type InspectorView } from "../inspector/agent-inspector";
import { ConversationSidebar } from "../sidebar/conversations";
import { SideDrawer } from "../workspace/side-drawer";
import { Composer } from "./composer";
import { MessageItem } from "./message-item";
import { Suggestions, Welcome } from "./welcome";

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
  const [draft] = useState(createDraftStore);
  const chat = useChat(draft);
  const input = useRef<HTMLTextAreaElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const transcriptColumn = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [inspectedId, setInspectedId] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>();
  const [inspectorView, setInspectorView] = useState<InspectorView>("activity");
  const [drawer, setDrawer] = useState<"conversations" | "inspector">();
  const [conversationView, setConversationView] = useState(0);
  const closeDrawer = useCallback(() => setDrawer(undefined), []);
  const inspected = chat.messages.find(item => item.id === inspectedId)?.response
    ?? chat.messages.findLast(item => item.response)?.response ?? undefined;
  const welcoming = !chat.loading && chat.messages.length === 0 && !chat.pending;
  const inspectorVisible = inspectorOpen ?? !!chat.messages.length;
  const pendingKey = chat.pending && answerKey(chat.pending.id);
  const visibleMessages: typeof chat.messages = chat.pending && pendingKey ? [...chat.messages, chat.pending, {
    id: pendingKey, role: "assistant", content: chat.preview, timestamp: chat.pending.timestamp,
  }] : chat.messages;
  const progress = chat.stage ? (stageLabels[chat.stage] ?? chat.stage) : "Waiting for Echo…";
  const streamLabel = chat.sources.length ? progress + " · " + chat.sources.length + " sources received" : progress;

  useLayoutEffect(() => {
    const view = transcript.current;
    if (view && followBottom.current) view.scrollTop = view.scrollHeight;
  }, [chat.messages, chat.pending, chat.preview, conversationView]);

  useLayoutEffect(() => {
    const view = transcript.current;
    const column = transcriptColumn.current;
    if (!view || !column) return;
    const observer = new ResizeObserver(() => {
      if (followBottom.current) view.scrollTop = view.scrollHeight;
    });
    observer.observe(view);
    observer.observe(column);
    return () => observer.disconnect();
  }, [conversationView]);

  async function openConversation(session?: Session) {
    followBottom.current = true;
    setInspectedId(undefined);
    closeDrawer();
    if (await chat.openConversation(session)) {
      if (!session) setInspectorOpen(undefined);
      setShowJump(false);
      setConversationView(previous => previous + 1);
    }
  }

  const openInspector = useCallback((view: InspectorView) => {
    setInspectorView(view);
    if (window.matchMedia("(min-width: 1200px)").matches) setInspectorOpen(true);
    else setDrawer("inspector");
  }, []);

  const inspect = useCallback((messageId: string) => {
    setInspectedId(messageId);
    openInspector("activity");
  }, [openInspector]);

  const sidebar = {
    sessions: chat.sessions,
    previews: chat.previews,
    activeId: chat.session?.id,
    busy: chat.busy,
    loading: chat.loading,
    onNew: () => openConversation(),
    onSelect: openConversation,
    onMemory: () => openInspector("memory"),
  };

  return (
    <div className="echo-app" data-sidebar-open={sidebarOpen} data-inspector-open={inspectorVisible}>
      <aside className="sidebar-shell" id="desktop-conversations" data-collapsed={!sidebarOpen || undefined}>
        <ConversationSidebar {...sidebar} collapsed={!sidebarOpen} onCollapse={() => {
          setSidebarOpen(false);
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".desktop-conversations-toggle")?.focus());
        }} />
      </aside>
      <main className="workspace" data-welcome={welcoming || undefined}>
        <header className="workspace-bar">
          <div className="workspace-path">
            <button type="button" className="icon-button desktop-conversations-toggle" hidden={sidebarOpen}
              aria-label="Expand conversations"
              aria-expanded={sidebarOpen} aria-controls="desktop-conversations"
              onClick={() => setSidebarOpen(open => !open)}><PanelLeft size={19} aria-hidden="true" /></button>
            <button type="button" className="icon-button mobile-conversations-toggle"
              aria-label="Open conversations" aria-haspopup="dialog"
              onClick={() => setDrawer("conversations")}><PanelLeft size={20} aria-hidden="true" /></button>
            {welcoming ? (
              <h1 className="workspace-home"><span className="echo-mark"><AudioLines size={14} aria-hidden="true" /></span> Echo</h1>
            ) : (
              <>
                <span className="mobile-echo" aria-hidden="true"><AudioLines size={18} /> Echo</span>
                <span className="workspace-root">Workspace</span><ChevronRight className="workspace-chevron" size={14} aria-hidden="true" />
                <h1>{chat.session?.title ?? (chat.messages.length ? "Untitled conversation" : "New conversation")}</h1>
              </>
            )}
          </div>
          <button type="button" ref={inspectorToggle} className="inspector-toggle desktop-inspector-toggle"
            aria-expanded={inspectorVisible} aria-controls="desktop-inspector"
            onClick={() => setInspectorOpen(!inspectorVisible)}>
            <PanelRight size={16} aria-hidden="true" /> <span>Inspector</span>
          </button>
          <button type="button" className="inspector-toggle mobile-inspector-toggle"
            aria-label="Open Agent Inspector" aria-haspopup="dialog" onClick={() => setDrawer("inspector")}>
            <PanelRight size={18} aria-hidden="true" /> <span>Inspector</span>
          </button>
        </header>
        <div className="workspace-body">
          <div className="transcript-frame">
            <div className="transcript" ref={transcript} role="region" aria-label="Conversation messages" tabIndex={welcoming ? undefined : 0}
              onScroll={event => {
                const view = event.currentTarget;
                followBottom.current = view.scrollHeight - view.clientHeight - view.scrollTop < 80;
                setShowJump(!followBottom.current);
              }}>
              <div className="chat-column transcript-column" key={conversationView} ref={transcriptColumn}>
                {chat.loading && <p role="status" className="chat-status"><LoaderCircle size={16} aria-hidden="true" /> Loading conversation…</p>}
                {welcoming && <Welcome />}
                {visibleMessages.map(message => (
                  <MessageItem key={message.renderKey ?? message.id} message={message}
                    entering={!!message.renderKey || message.id === chat.pending?.id || message.id === pendingKey}
                    streaming={message.id === pendingKey ? streamLabel : undefined}
                    inspect={message.response ? inspect : undefined}
                    inspected={!!message.response && message.response.message_id === inspected?.message_id} />
                ))}
            </div>
          </div>
          {showJump && !welcoming && <button type="button" className="jump-latest" onClick={() => {
            const view = transcript.current;
            const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            view?.focus({ preventScroll: true });
            view?.scrollTo({ top: view.scrollHeight, behavior: reduced ? "instant" : "smooth" });
          }}><ArrowDown size={15} aria-hidden="true" /> Latest reply</button>}
          </div>
          <Composer input={input} draft={draft} busy={chat.busy} sending={!!chat.pending} welcoming={welcoming}
            error={chat.error} failedDraft={chat.failedDraft} onStop={chat.cancel}
            onSuggestions={() => document.querySelector<HTMLButtonElement>("#suggested-questions button")?.focus()}
            onSend={() => {
              if (chat.busy || !draft.read().trim()) return;
              followBottom.current = true;
              setShowJump(false);
              setInspectedId(undefined);
              input.current?.focus({ preventScroll: true });
              void chat.send();
            }} />
          {welcoming && <Suggestions draft={draft} disabled={chat.busy}
            onPrompt={prompt => { draft.write(prompt); input.current?.focus(); }} />}
        </div>
      </main>
      <aside className="inspector-shell" id="desktop-inspector" inert={!inspectorVisible}>
        <AgentInspector reply={inspected} visible={inspectorVisible && drawer !== "inspector"}
          view={inspectorView} onView={setInspectorView} onClose={() => {
          setInspectorOpen(false);
          inspectorToggle.current?.focus();
        }} />
      </aside>
      <SideDrawer open={drawer === "conversations"} side="left" label="Conversations" desktopAt={960} onClose={closeDrawer}>
        <ConversationSidebar {...sidebar} onClose={closeDrawer} />
      </SideDrawer>
      <SideDrawer open={drawer === "inspector"} side="right" label="Agent Inspector" desktopAt={1200} onClose={closeDrawer}>
        <AgentInspector reply={inspected} onClose={closeDrawer} visible={drawer === "inspector"}
          view={inspectorView} onView={setInspectorView} drawer />
      </SideDrawer>
    </div>
  );
}
