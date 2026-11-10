"use client";

import { ArrowUpRight, Copy, Ellipsis } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export function ConversationMenu({ id, title, disabled, onOpen }: {
  id: string;
  title: string;
  disabled: boolean;
  onOpen: () => void;
}) {
  const label = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!expanded) return;
    function dismiss() {
      if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
    }
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [expanded]);

  function toggle() {
    const panel = menu.current;
    const anchor = trigger.current;
    if (!panel || !anchor) return;
    if (panel.matches(":popover-open")) {
      panel.hidePopover();
      return;
    }

    setNotice("");
    const bounds = anchor.getBoundingClientRect();
    panel.showPopover();
    const { width, height } = panel.getBoundingClientRect();
    const below = bounds.bottom + 5;
    const top = below + height + 8 <= window.innerHeight ? below : Math.max(8, bounds.top - height - 5);
    panel.style.left = Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)) + "px";
    panel.style.top = top + "px";
    panel.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus({ preventScroll: true });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      menu.current?.hidePopover();
      trigger.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      menu.current?.hidePopover();
      trigger.current?.focus();
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % items.length; break;
      case "ArrowUp": next = (index - 1 + items.length) % items.length; break;
      case "Home": next = 0; break;
      case "End": next = items.length - 1; break;
      default: return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(id);
      setNotice("Conversation ID copied.");
    } catch {
      setNotice("Could not copy the conversation ID.");
    }
  }

  return (
    <>
      <button ref={trigger} id={label} className="icon-button conversation-menu-trigger" type="button"
        aria-label={"Options for " + title} aria-haspopup="menu" aria-expanded={expanded} disabled={disabled}
        onClick={toggle}>
        <Ellipsis size={17} aria-hidden="true" />
      </button>
      <div className="conversation-menu" popover="auto" ref={menu} role="menu" aria-labelledby={label}
        onToggle={event => setExpanded(event.newState === "open")} onKeyDown={onKeyDown}>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => {
          menu.current?.hidePopover();
          trigger.current?.focus();
          onOpen();
        }}>
          <ArrowUpRight size={15} aria-hidden="true" /> Open conversation
        </button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => void copyId()}>
          <Copy size={15} aria-hidden="true" /> Copy conversation ID
        </button>
        <p className="conversation-menu-notice" role="status">{notice}</p>
      </div>
    </>
  );
}
