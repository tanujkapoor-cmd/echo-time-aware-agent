import type { ChatReply, ChatRequest, Message, Session } from "./types";

const root = "/api/v1";

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
    public traceId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export async function request(path: string, options: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(root + path, { cache: "no-store", ...options });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError("Could not reach Echo. Check that both servers are running.");
  }

  if (!response.ok) {
    const body = record(await response.json().catch(() => undefined));
    const detail = record(body?.error);
    const code = typeof detail?.code === "string" ? detail.code : undefined;
    const trace = typeof detail?.trace_id === "string" ? detail.trace_id : undefined;
    const message = typeof detail?.message === "string" ? detail.message
      : response.status === 422 ? "Echo rejected the request. Check the session and message."
      : response.status >= 500 ? "Echo is unavailable. Check that the backend is running."
      : "Echo rejected the request (HTTP " + response.status + ").";
    throw new ApiError(message, response.status, code, trace);
  }
  return response;
}

export function post(body: object, signal?: AbortSignal): RequestInit {
  return {
    method: "POST", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => {
    throw new ApiError("Echo returned an empty or unreadable response.");
  });
}

function isSession(value: unknown): value is Session {
  const row = record(value);
  return typeof row?.id === "string" && typeof row.created_at === "string"
    && (row.title === null || typeof row.title === "string");
}

export function isReply(value: unknown): value is ChatReply {
  const row = record(value);
  return typeof row?.message_id === "string" && typeof row.answer === "string"
    && row.answer.trim().length > 0 && typeof row.timestamp === "string";
}

function isMessage(value: unknown): value is Message {
  const row = record(value);
  return typeof row?.id === "string" && (row.role === "user" || row.role === "assistant")
    && typeof row.content === "string" && typeof row.timestamp === "string"
    && (row.response == null || isReply(row.response));
}

export async function createSession(title?: string, signal?: AbortSignal): Promise<Session> {
  const data = await json(await request("/sessions", post(title ? { title } : {}, signal)));
  if (!isSession(data)) throw new ApiError("Echo returned an invalid conversation.");
  return data;
}

export async function listSessions(signal?: AbortSignal): Promise<Session[]> {
  const result = new Map<string, Session>();
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await json(await request("/sessions?limit=" + limit + "&offset=" + offset, { signal }));
    if (!Array.isArray(page) || !page.every(isSession)) {
      throw new ApiError("Echo returned an invalid conversation list.");
    }
    for (const session of page) result.set(session.id, session);
    if (page.length < limit) return [...result.values()];
  }
}

export async function listMessages(id: string, signal?: AbortSignal): Promise<Message[]> {
  const messages: Message[] = [];
  const limit = 100;
  for (let after = 0; ; after += limit) {
    const path = "/sessions/" + encodeURIComponent(id) + "/messages?limit=" + limit + "&after=" + after;
    const page = await json(await request(path, { signal }));
    if (!Array.isArray(page) || !page.every(isMessage)) {
      throw new ApiError("Echo returned invalid conversation history.");
    }
    messages.push(...page);
    if (page.length < limit * 2) return messages;
  }
}

export async function sendMessage(body: ChatRequest, signal?: AbortSignal): Promise<ChatReply> {
  const data = await json(await request("/chat", post(body, signal)));
  if (!isReply(data)) throw new ApiError("Echo returned an empty or invalid answer.");
  return data;
}
