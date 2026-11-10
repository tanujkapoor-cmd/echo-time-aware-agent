"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createSession, listMessages, listSessions } from "../lib/api";
import { streamMessage } from "../lib/sse";
import type { ChatRequest, Citation, Message, Session } from "../lib/types";

function errorText(error: unknown) {
  if (error instanceof ApiError && error.traceId) return error.message + " Trace ID " + error.traceId;
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
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [session, setSession] = useState<Session>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Message>();
  const [preview, setPreview] = useState("");
  const [stage, setStage] = useState<string>();
  const [sources, setSources] = useState<Citation[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [failedDraft, setFailedDraft] = useState<string>();
  const operation = useRef(false);
  const turn = useRef<AbortController | undefined>(undefined);
  const retry = useRef<ChatRequest | undefined>(undefined);

  const showHistory = useCallback((id: string, history: Message[]) => {
    setMessages(history);
    const latestQuestion = history.findLast(message => message.role === "user");
    if (latestQuestion) setPreviews(previous => ({ ...previous, [id]: latestQuestion.content }));
  }, []);

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
        showHistory(selected.id, history);
      } catch (failure) {
        if (!signal.aborted) setError(errorText(failure));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }

    void restore();
    return () => {
      controller.abort();
      turn.current?.abort();
    };
  }, [showHistory]);

  async function openConversation(target?: Session) {
    if (operation.current || loading || (target && target.id === session?.id)) return;
    operation.current = true;
    setBusy(true);
    setError(undefined);
    setFailedDraft(undefined);

    try {
      const selected = target ?? await createSession();
      const history = target ? await listMessages(selected.id) : [];
      if (!target) setSessions(previous => [selected, ...previous]);
      setSession(selected);
      showHistory(selected.id, history);
      setDraft("");
      retry.current = undefined;
      rememberSelection(selected.id);
      return true;
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
    const controller = new AbortController();
    turn.current = controller;
    const { signal } = controller;
    setBusy(true);
    setError(undefined);
    setFailedDraft(undefined);
    setDraft("");

    const saved = retry.current;
    const requestId = saved && saved.session_id === session?.id && saved.message === text
      ? saved.request_id : crypto.randomUUID();
    const outgoing: Message = {
      id: requestId, role: "user", content: text, timestamp: new Date().toISOString(),
    };
    setPending(outgoing);

    try {
      const active = session ?? await createSession(Array.from(text).slice(0, 64).join(""), signal);
      if (!session) setSessions(previous => [active, ...previous]);
      setSession(active);
      rememberSelection(active.id);
      const request = { session_id: active.id, message: text, request_id: requestId };
      retry.current = request;
      const reply = await streamMessage(request, {
        status: setStage,
        sources: setSources,
        token: chunk => setPreview(previous => previous + chunk),
      }, signal);
      retry.current = undefined;
      setPreviews(previous => ({ ...previous, [active.id]: outgoing.content }));
      setMessages(previous => [
        ...previous.filter(item => item.id !== outgoing.id && item.id !== reply.message_id),
        outgoing,
        { id: reply.message_id, role: "assistant", content: reply.answer,
          timestamp: reply.timestamp, response: reply },
      ]);
      setPending(undefined);

      try {
        showHistory(active.id, await listMessages(active.id, signal));
      } catch (historyError) {
        if (!signal.aborted) {
          setError("Answer saved. Could not refresh conversation history. " + errorText(historyError));
        }
      }
    } catch (sendError) {
      setDraft(text);
      setFailedDraft(text);
      setError(signal.aborted ? "Response canceled. Send the same message again to retry." : errorText(sendError));
    } finally {
      turn.current = undefined;
      setPending(undefined);
      setPreview("");
      setStage(undefined);
      setSources([]);
      setBusy(false);
      operation.current = false;
    }
  }

  return {
    sessions, previews, session, messages, draft, setDraft, pending, loading,
    busy: busy || loading, error, canRetry: !!failedDraft && failedDraft === draft.trim(),
    send, openConversation, preview, stage, sources,
    cancel: () => turn.current?.abort(),
  };
}
