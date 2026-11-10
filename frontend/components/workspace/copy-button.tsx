"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<"copied" | "failed">();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    timer.current = setTimeout(() => setStatus(undefined), 2200);
  }

  return (
    <>
      <button className="icon-button compact-action" type="button" onClick={() => void copy()}
        title={status === "copied" ? "Copied" : label} aria-label={label}>
        {status === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      </button>
      <span className="sr-only" role="status">{status === "copied" ? "Copied" : status === "failed" ? "Could not copy" : ""}</span>
    </>
  );
}
