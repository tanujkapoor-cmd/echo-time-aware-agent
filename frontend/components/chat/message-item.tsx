import { PanelRight } from "lucide-react";
import Markdown from "react-markdown";
import { formatTimestamp, webLink } from "../../lib/presentation";
import type { Message } from "../../lib/types";

export function MessageItem({ message, inspect, inspected }: {
  message: Message;
  inspect?: () => void;
  inspected?: boolean;
}) {
  const user = message.role === "user";
  return (
    <article className={user ? "ml-auto max-w-[90%] rounded-2xl bg-neutral-100 px-4 py-3 sm:max-w-[80%]" : "min-w-0"}>
      <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-semibold">{user ? "You" : "Echo"}</span>
        <time dateTime={message.timestamp} className="text-xs text-neutral-600">{formatTimestamp(message.timestamp)}</time>
        {inspect && (
          <button type="button" onClick={inspect} aria-pressed={inspected}
            className="ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-indigo-800 hover:bg-indigo-50 aria-pressed:bg-indigo-50">
            <PanelRight className="size-3.5" aria-hidden="true" /> Inspect
          </button>
        )}
      </header>
      {user ? <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed">{message.content}</p> : (
        <div className="message-body">
          <Markdown skipHtml disallowedElements={["img"]}
            components={{
              a({ href, children }) {
                const safe = webLink(href);
                return safe
                  ? <a href={safe} target="_blank" rel="noreferrer noopener">{children}</a>
                  : <span>{children}</span>;
              },
            }}>
            {message.content}
          </Markdown>
        </div>
      )}
      {!!message.response?.citations?.length && (
        <ul aria-label="Citations" className="mt-3 flex flex-wrap gap-2">
          {message.response.citations.map((source, index) => {
            const url = webLink(source.url);
            const title = "[" + source.id + "] " + source.title;
            return <li key={source.id + index} className="min-w-0 max-w-full">
              {url ? <a href={url} target="_blank" rel="noreferrer noopener"
                className="inline-block max-w-full rounded-md border border-neutral-200 px-2 py-1 text-xs text-indigo-800 wrap-anywhere hover:underline">{title}</a>
                : <span className="text-xs text-neutral-600">{title}</span>}
            </li>;
          })}
        </ul>
      )}
    </article>
  );
}
