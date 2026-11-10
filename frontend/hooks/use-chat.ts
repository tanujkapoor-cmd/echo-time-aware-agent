"use client";

import { useRef, useState } from "react";
import { createSession, listMessages, sendMessage } from "../lib/api";
import type { ChatRequest, Message, Session } from "../lib/types";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function useChat() {
  const [session, setSession] = useState<Session>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const operation = useRef(false);
  const retry = useRef<ChatRequest | undefined>(undefined);

  async function send() {
    const text = draft.trim();
    if (operation.current || !text) return;
    operation.current = true;
    setBusy(true);
    setError(undefined);
    setDraft("");

    const saved = retry.current;
    const requestId = saved && saved.session_id === session?.id && saved.message === text
      ? saved.request_id : crypto.randomUUID();
    const outgoing: Message = {
      id: requestId, role: "user", content: text, timestamp: new Date().toISOString(),
    };
    setPending(outgoing);

    try {
      const active = session ?? await createSession(Array.from(text).slice(0, 64).join(""));
      setSession(active);
      const request = { session_id: active.id, message: text, request_id: requestId };
      retry.current = request;
      const reply = await sendMessage(request);
      retry.current = undefined;
      setMessages(previous => [
        ...previous.filter(item => item.id !== outgoing.id && item.id !== reply.message_id),
        outgoing,
        { id: reply.message_id, role: "assistant", content: reply.answer,
          timestamp: reply.timestamp, response: reply },
      ]);
      setPending(undefined);

      try {
        setMessages(await listMessages(active.id));
      } catch (historyError) {
        setError("Answer saved. Could not refresh conversation history. " + errorText(historyError));
      }
    } catch (sendError) {
      setDraft(text);
      setError(errorText(sendError));
    } finally {
      setPending(undefined);
      setBusy(false);
      operation.current = false;
    }
  }

  return { session, messages, draft, setDraft, pending, busy, error, send };
}
