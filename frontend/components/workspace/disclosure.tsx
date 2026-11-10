import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="disclosure" data-open={open}>
      <button type="button" className="disclosure-toggle" aria-expanded={open}
        aria-controls={id} onClick={() => setOpen(value => !value)}>
        {label}<ChevronDown size={14} aria-hidden="true" />
      </button>
      <div className="disclosure-content" id={id} inert={!open}>
        <div className="disclosure-inner">{children}</div>
      </div>
    </div>
  );
}
