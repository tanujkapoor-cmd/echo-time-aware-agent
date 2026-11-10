"use client";

import { useEffect, useRef, useState } from "react";
import { createSession, listMessages, listSessions, sendMessage } from "../lib/api";
import type { ChatRequest, Message, Session } from "../lib/types";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

const sessionKey = "echo.active-session";

function readSelection() {
  try { return localStorage.getItem(sessionKey); } catch { return null; }
}

function rememberSelection(id: string) {
  try { localStorage.setItem(sessionKey, id); } catch { /* Storage may be disabled. */ }
}

export function useChat() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const operation = useRef(false);
  const retry = useRef<ChatRequest | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function restore() {
      try {
        const available = await listSessions(signal);
        if (signal.aborted) return;
        setSessions(available);
        const selected = available.find(item => item.id === readSelection()) ?? available[0];
        if (!selected) return;
        const history = await listMessages(selected.id, signal);
        if (signal.aborted) return;
        setSession(selected);
        setMessages(history);
      } catch (failure) {
        if (!signal.aborted) setError(errorText(failure));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }

    void restore();
    return () => controller.abort();
  }, []);

  async function openConversation(target?: Session) {
    if (operation.current || loading || (target && target.id === session?.id)) return;
    operation.current = true;
    setBusy(true);
    setError(undefined);

    try {
      const selected = target ?? await createSession();
      const history = target ? await listMessages(selected.id) : [];
      if (!target) setSessions(previous => [selected, ...previous]);
      setSession(selected);
      setMessages(history);
      setDraft("");
      retry.current = undefined;
      rememberSelection(selected.id);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  async function send() {
    const text = draft.trim();
    if (operation.current || loading || !text) return;
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
      if (!session) setSessions(previous => [active, ...previous]);
      setSession(active);
      rememberSelection(active.id);
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

  return {
    sessions, session, messages, draft, setDraft, pending, loading,
    busy: busy || loading, error, send, openConversation,
  };
}
