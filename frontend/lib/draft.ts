export function createDraftStore() {
  let value = "";
  const listeners = new Set<() => void>();

  return {
    read: () => value,
    write(next: string) {
      if (value === next) return;
      value = next;
      listeners.forEach(listener => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;
