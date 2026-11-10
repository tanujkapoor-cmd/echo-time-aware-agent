import { ApiError, isCitation, isReply, post, record, request, sendMessage } from "./api.ts";
import type { ChatReply, ChatRequest, Citation } from "./types";

export interface StreamUpdates {
  status: (stage: string) => void;
  sources: (citations: Citation[]) => void;
  token: (text: string) => void;
}

export async function* readEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let index: number;
      while ((index = buffer.search(/[\r\n]/)) >= 0) {
        if (!done && buffer[index] === "\r" && index === buffer.length - 1) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer.slice(index, index + 2) === "\r\n" ? 2 : 1));
        if (!line) {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
          continue;
        }
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        if (field === "data") data.push(value);
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const events = new Set(["status", "sources", "token", "error", "completed"]);

export async function streamMessage(
  body: ChatRequest,
  updates: StreamUpdates,
  signal: AbortSignal,
): Promise<ChatReply> {
  let response: Response;
  try {
    response = await request("/chat/stream", post(body, signal));
  } catch (error) {
    if (error instanceof ApiError && !error.code && [404, 405, 501].includes(error.status ?? 0)) {
      return sendMessage(body, signal);
    }
    throw error;
  }
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    throw new ApiError("Echo returned an unreadable chat stream.");
  }

  let failure: ApiError | undefined;
  try {
    for await (const frame of readEvents(response.body)) {
      if (!events.has(frame.event)) continue;
      const payload = record(JSON.parse(frame.data));
      if (frame.event === "status" && typeof payload?.stage === "string") {
        updates.status(payload.stage);
      } else if (frame.event === "sources" && Array.isArray(payload?.citations) && payload.citations.every(isCitation)) {
        updates.sources(payload.citations);
      } else if (frame.event === "token" && typeof payload?.text === "string") {
        updates.token(payload.text);
      } else if (frame.event === "error" && typeof payload?.message === "string") {
        failure = new ApiError(payload.message, undefined,
          typeof payload.code === "string" ? payload.code : undefined,
          typeof payload.trace_id === "string" ? payload.trace_id : undefined);
      } else if (frame.event === "completed" && payload?.ok === false) {
        throw failure ?? new ApiError("Echo could not finish this turn.");
      } else if (frame.event === "completed" && payload?.ok === true && isReply(payload.response) && !failure) {
        return payload.response;
      } else {
        throw new ApiError("Echo sent a malformed chat event.");
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof ApiError) throw error;
    if (error instanceof SyntaxError) throw new ApiError("Echo sent a malformed chat event.");
    throw failure ?? new ApiError("The chat stream was interrupted. Send the same message again to retry.");
  }
  throw failure ?? new ApiError("The chat stream ended early. Send the same message again to retry.");
}
