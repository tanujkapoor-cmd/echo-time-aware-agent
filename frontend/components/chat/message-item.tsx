import { ArrowUpRight, AudioLines, Layers, LoaderCircle, PanelRight } from "lucide-react";
import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatTimestamp, webLink } from "../../lib/presentation";
import type { Message } from "../../lib/types";
import { CopyButton } from "../workspace/copy-button";

export const MessageItem = memo(function MessageItem({ message, inspect, inspected, entering, streaming }: {
  message: Message;
  inspect?: (id: string) => void;
  inspected?: boolean;
  entering?: boolean;
  streaming?: string;
}) {
  const user = message.role === "user";
  return (
    <article className={"message " + (user ? "message--user" : "message--assistant")}
      data-entering={entering || undefined} data-streaming={!!streaming || undefined}>
      <header className="message-head">
        {!user && <span className="echo-mark message-avatar"><AudioLines size={17} aria-hidden="true" /></span>}
        <div>
          <p className="message-role">{user ? "You" : "Echo"}</p>
          {streaming
            ? <p className="message-progress" role="status"><LoaderCircle size={12} aria-hidden="true" /> {streaming}</p>
            : <time dateTime={message.timestamp}>{formatTimestamp(message.timestamp)}</time>}
        </div>
        {!streaming && <div className="message-actions">
          {message.response?.memory_used === true && <span className="message-memory">
            <Layers size={12} aria-hidden="true" /> Context used
          </span>}
          <CopyButton text={message.content} label="Copy message" />
          {inspect && <button type="button" onClick={() => inspect(message.id)} aria-pressed={inspected} className="inspect-button">
            <PanelRight size={14} aria-hidden="true" /> Inspect
          </button>}
        </div>}
      </header>
      {user ? <p className="message-text">{message.content}</p> : (
        <div className="message-body">
          <Markdown skipHtml disallowedElements={["img"]} remarkPlugins={[remarkGfm]}
            components={{
              a({ href, children }) {
                const safe = webLink(href);
                return safe
                  ? <a href={safe} target="_blank" rel="noreferrer noopener">{children}</a>
                  : <span>{children}</span>;
              },
              table({ children }) {
                return <div className="markdown-table" role="region" aria-label="Table" tabIndex={0}><table>{children}</table></div>;
              },
            }}>
            {message.content}
          </Markdown>
        </div>
      )}
      {!!message.response?.citations?.length && (
        <ul aria-label="Citations" className="message-citations">
          {message.response.citations.map((source, index) => {
            const url = webLink(source.url);
            return <li key={source.id + index}>
              {url ? <a href={url} target="_blank" rel="noreferrer noopener" className="citation-link" title={source.title}>
                <span className="source-id">{source.id}</span><span>{source.title}</span><ArrowUpRight size={13} aria-hidden="true" />
              </a> : <span className="citation-link"><span className="source-id">{source.id}</span> {source.title}</span>}
            </li>;
          })}
        </ul>
      )}
    </article>
  );
});
