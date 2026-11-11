import { ArrowUp, CircleAlert, CornerDownLeft, RotateCcw, Sparkles, Square } from "lucide-react";
import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import type { DraftStore } from "../../lib/draft";

export function Composer({ input, draft, busy, sending, welcoming, error, failedDraft, onSend, onStop, onSuggestions }: {
  input: RefObject<HTMLTextAreaElement | null>;
  draft: DraftStore;
  busy: boolean;
  sending: boolean;
  welcoming: boolean;
  error?: string;
  failedDraft?: string;
  onSend: () => void;
  onStop: () => void;
  onSuggestions: () => void;
}) {
  const value = useSyncExternalStore(draft.subscribe, draft.read, draft.read);
  const mirror = useRef<HTMLDivElement>(null);
  const canRetry = !!failedDraft && failedDraft === value.trim();

  useLayoutEffect(() => {
    const measure = mirror.current;
    const field = measure?.parentElement;
    if (!measure || !field) return;
    const update = () => field.style.setProperty("--composer-height", measure.offsetHeight + "px");
    const observer = new ResizeObserver(update);
    observer.observe(measure);
    update();
    return () => observer.disconnect();
  }, []);

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
          <div className="composer-field">
            <div className="composer-mirror" ref={mirror} aria-hidden="true">{value + "\u200b"}</div>
            <textarea id="message" ref={input} rows={1} maxLength={4000} value={value}
              readOnly={busy} placeholder={welcoming ? "Ask Echo anything…" : "Message Echo"}
              onChange={event => draft.write(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }} />
          </div>
          <div className="composer-actions">
          {welcoming && <button type="button" className="composer-ideas" onClick={onSuggestions} disabled={busy}>
            <Sparkles size={15} aria-hidden="true" /> Prompt ideas
          </button>}
          {sending
            ? <button type="button" className="stop-button" onClick={event => { event.preventDefault(); onStop(); }}>
              <Square size={13} aria-hidden="true" /> Stop
            </button>
            : <button type="submit" className="send-button" aria-label="Send" disabled={busy || !value.trim()}>
              <ArrowUp size={19} aria-hidden="true" />
            </button>}
          </div>
        </div>
        <div className="composer-foot">
          <span><CornerDownLeft size={12} aria-hidden="true" /> Enter to send <span className="shortcut-extra">· Shift + Enter for a new line</span></span>
          {value.length > 0 && <span>{value.length.toLocaleString()} / 4,000</span>}
        </div>
      </form>
    </div>
  );
}
