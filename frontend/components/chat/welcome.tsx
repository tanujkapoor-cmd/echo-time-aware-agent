import { ArrowUpRight, Globe2, History, Lightbulb } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { DraftStore } from "../../lib/draft";
import { Orb } from "./orb";

const prompts = [
  { icon: Globe2, title: "Check a current fact", text: "What is the latest stable Python release?" },
  { icon: History, title: "Recall earlier context", text: "What did I ask about last week?" },
  { icon: Lightbulb, title: "Explore a topic", text: "Explain how binary search works." },
];

export function Welcome() {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <Orb />
      <p>Welcome to Echo</p>
      <h2 id="welcome-title">How can I assist you today?</h2>
    </section>
  );
}

export function Suggestions({ draft, disabled, onPrompt }: {
  draft: DraftStore;
  disabled: boolean;
  onPrompt: (text: string) => void;
}) {
  const selection = () => prompts.find(prompt => prompt.text === draft.read())?.text;
  const selected = useSyncExternalStore(draft.subscribe, selection, selection);
  return (
    <section className="suggestion-section" id="suggested-questions" aria-label="Suggested questions">
      <ul className="suggestions">
        {prompts.map(({ icon: Icon, title, text }) => (
          <li key={text}>
            <button type="button" className="suggestion" disabled={disabled}
              aria-pressed={selected === text} onClick={() => onPrompt(text)}>
              <Icon size={20} aria-hidden="true" />
              <ArrowUpRight size={15} className="suggestion-arrow" aria-hidden="true" />
              <strong>{title}</strong>
              <span>{text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
