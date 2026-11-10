"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function SideDrawer({ open, side, label, desktopAt, onClose, children }: {
  open: boolean;
  side: "left" | "right";
  label: string;
  desktopAt: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const desktop = window.matchMedia("(min-width: " + desktopAt + "px)");
    const check = () => { if (desktop.matches) onClose(); };
    desktop.addEventListener("change", check);
    check();
    return () => desktop.removeEventListener("change", check);
  }, [desktopAt, onClose, open]);

  return (
    <dialog
      ref={ref}
      className={"side-drawer side-drawer--" + side}
      aria-label={label}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="drawer-inner">{children}</div>
    </dialog>
  );
}
