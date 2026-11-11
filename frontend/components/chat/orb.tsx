import { AudioLines } from "lucide-react";
import { useEffect, useRef } from "react";

export function Orb() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let dispose: (() => void) | undefined;
    let canceled = false;

    void import("./orb-scene").then(({ mountOrb }) => {
      if (!canceled) dispose = mountOrb(host);
    }).catch(() => { /* The Echo mark stays visible if the scene cannot load. */ });

    return () => {
      canceled = true;
      dispose?.();
    };
  }, []);

  return (
    <div className="welcome-orb" ref={container} aria-hidden="true">
      <span className="echo-mark orb-fallback"><AudioLines size={35} /></span>
    </div>
  );
}
