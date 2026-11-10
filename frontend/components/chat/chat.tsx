"use client";

import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { useChat } from "../../hooks/use-chat";
import { ConversationSidebar } from "../sidebar/conversations";
import { MessageItem } from "./message-item";

const prompts = [
  "What is the latest stable Python release?",
  "What is the latest stable Node.js release?",
  "Explain how binary search works.",
];

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
  const transcript = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);

  useEffect(() => {
    const view = transcript.current;
    if (view && followBottom.current) view.scrollTop = view.scrollHeight;
  }, [chat.messages, chat.pending, chat.preview]);

  return (
    <div className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
    <ConversationSidebar sessions={chat.sessions} activeId={chat.session?.id} busy={chat.busy} loading={chat.loading}
      onNew={() => { followBottom.current = true; void chat.openConversation(); }}
      onSelect={session => { followBottom.current = true; void chat.openConversation(session); }} />
    <main className="flex min-h-0 min-w-0 flex-col bg-white">
      <header className="flex min-h-16 items-center gap-3 border-b border-neutral-200 px-5">
        <h1 className="truncate font-semibold">{chat.session?.title ?? "Conversation"}</h1>
      </header>
      <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto"
        onScroll={event => {
          const view = event.currentTarget;
          followBottom.current = view.scrollHeight - view.clientHeight - view.scrollTop < 80;
        }}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-7 sm:px-8">
          {chat.loading && <p role="status" className="text-sm text-neutral-600">Loading conversation…</p>}
          {!chat.loading && chat.messages.length === 0 && !chat.pending && (
            <section className="pt-8 sm:pt-14">
              <h2 className="text-2xl font-semibold tracking-tight">Start a conversation</h2>
              <p className="mt-2 text-sm text-neutral-600">Ask a question, then follow up in the same chat.</p>
              <ul className="mt-6 grid gap-2">
                {prompts.map(prompt => (
                  <li key={prompt}>
                    <button type="button" onClick={() => { chat.setDraft(prompt); input.current?.focus(); }}
                      disabled={chat.busy}
                      className="min-h-11 w-full rounded-lg border border-neutral-200 px-4 py-2 text-left text-sm hover:bg-neutral-50 disabled:opacity-50">
                      {prompt}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {chat.messages.map(message => <MessageItem key={message.id} message={message} />)}
          {chat.pending && <MessageItem message={chat.pending} />}
          {chat.pending && <p role="status" className="flex items-center gap-2 text-sm text-neutral-600">
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            {chat.stage ? (stageLabels[chat.stage] ?? chat.stage) : "Waiting for Echo…"}
            {chat.sources.length > 0 && <span>· {chat.sources.length} sources received</span>}
          </p>}
          {chat.pending && chat.preview && <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed">{chat.preview}</p>}
        </div>
      </div>
      <div className="border-t border-neutral-200 px-4 py-3">
        <form className="mx-auto w-full max-w-3xl" onSubmit={event => {
          event.preventDefault();
          followBottom.current = true;
          void chat.send();
        }}>
          {chat.error && <p role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{chat.error}</p>}
          <div className="flex items-end gap-2 rounded-xl border border-neutral-300 p-2">
            <label htmlFor="message" className="sr-only">Message</label>
            <textarea id="message" ref={input} rows={2} maxLength={4000} value={chat.draft}
              readOnly={chat.busy} placeholder="Message Echo"
              onChange={event => chat.setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              className="min-h-11 max-h-40 min-w-0 flex-1 resize-y rounded-md px-2 py-1.5 text-base placeholder:text-neutral-500" />
            {chat.pending ? (
              <button type="button" onClick={chat.cancel}
                className="flex min-h-11 items-center gap-1.5 rounded-lg border border-neutral-300 px-3 text-sm font-semibold hover:bg-neutral-100">
                <Square className="size-3" aria-hidden="true" /> Stop
              </button>
            ) : <button type="submit" disabled={chat.busy || !chat.draft.trim()}
              className="flex min-h-11 items-center gap-1.5 rounded-lg bg-indigo-700 px-3 text-sm font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-600">
              <ArrowUp className="size-4" aria-hidden="true" /> Send
            </button>}
          </div>
          <p className="mt-2 hidden text-xs text-neutral-600 sm:block">Enter to send · Shift+Enter for a new line</p>
        </form>
      </div>
    </main>
    </div>
  );
}
