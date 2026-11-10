import { ArrowUp, CircleAlert, CornerDownLeft, RotateCcw, Square } from "lucide-react";
import type { RefObject } from "react";

export function Composer({ input, draft, busy, sending, error, canRetry, onChange, onSend, onStop }: {
  input: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  busy: boolean;
  sending: boolean;
  error?: string;
  canRetry: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <div className="composer-wrap">
      <form className="chat-column" onSubmit={event => { event.preventDefault(); onSend(); }}>
        {error && <div className="composer-error">
          <p role="alert"><CircleAlert size={17} aria-hidden="true" /> <span>{error}</span></p>
          {canRetry && <button type="submit" className="retry-button" disabled={busy}>
            <RotateCcw size={14} aria-hidden="true" /> Retry
          </button>}
        </div>}
        <div className="composer" data-sending={sending || undefined}>
          <label htmlFor="message" className="sr-only">Message</label>
          <textarea id="message" ref={input} rows={1} maxLength={4000} value={draft}
            readOnly={busy} placeholder="Message Echo"
            onChange={event => onChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }} />
          {sending
            ? <button type="button" className="stop-button" onClick={event => { event.preventDefault(); onStop(); }}>
              <Square size={13} aria-hidden="true" /> Stop
            </button>
            : <button type="submit" className="send-button" disabled={busy || !draft.trim()}>
              <span>Send</span><ArrowUp size={17} aria-hidden="true" />
            </button>}
        </div>
        <div className="composer-foot">
          <span><CornerDownLeft size={12} aria-hidden="true" /> Enter to send <span className="shortcut-extra">· Shift + Enter for a new line</span></span>
          {draft.length > 0 && <span>{draft.length.toLocaleString()} / 4,000</span>}
        </div>
      </form>
    </div>
  );
}
