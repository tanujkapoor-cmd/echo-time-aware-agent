import { AudioLines } from "lucide-react";

export default function Page() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="flex items-center gap-3 text-2xl font-semibold">
        <AudioLines aria-hidden="true" className="size-6 text-indigo-700" /> Echo
      </h1>
      <p className="mt-3 text-neutral-600">Time-aware research chat.</p>
    </main>
  );
}
