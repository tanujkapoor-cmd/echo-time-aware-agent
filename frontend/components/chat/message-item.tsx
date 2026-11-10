import { ArrowUpRight, AudioLines, PanelRight } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatTimestamp, webLink } from "../../lib/presentation";
import type { Message } from "../../lib/types";
import { CopyButton } from "../workspace/copy-button";

export function MessageItem({ message, inspect, inspected }: {
  message: Message;
  inspect?: () => void;
  inspected?: boolean;
}) {
  const user = message.role === "user";
  return (
    <article className={"message " + (user ? "message--user" : "message--assistant")}>
      <header className="message-head">
        {!user && <span className="echo-mark message-avatar"><AudioLines size={17} aria-hidden="true" /></span>}
        <div>
          <p className="message-role">{user ? "You" : "Echo"}</p>
          <time dateTime={message.timestamp}>{formatTimestamp(message.timestamp)}</time>
        </div>
        <div className="message-actions">
          <CopyButton text={message.content} label="Copy message" />
          {inspect && <button type="button" onClick={inspect} aria-pressed={inspected} className="inspect-button">
            <PanelRight size={14} aria-hidden="true" /> Inspect
          </button>}
        </div>
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
}
