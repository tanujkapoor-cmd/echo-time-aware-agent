import { ArrowUpRight, AudioLines, Code2, GitBranch, Package } from "lucide-react";

const prompts = [
  { icon: Code2, text: "What is the latest stable Python release?" },
  { icon: Package, text: "What is the latest stable Node.js release?" },
  { icon: GitBranch, text: "Explain how binary search works." },
];

export function Welcome() {
  return (
    <section className="welcome">
      <div className="welcome-overline"><AudioLines size={15} aria-hidden="true" /> Time-aware chat</div>
      <h2>How can I <span>help today?</span></h2>
      <p>Explore a question, follow up on what you learned, or check what changed.</p>
    </section>
  );
}

export function Suggestions({ draft, disabled, onPrompt }: {
  draft: string;
  disabled: boolean;
  onPrompt: (text: string) => void;
}) {
  return (
    <section className="suggestion-section" aria-label="Suggested questions">
      <p className="suggestion-label">Try asking</p>
      <ul className="suggestions">
        {prompts.map(({ icon: Icon, text }) => (
          <li key={text}>
            <button type="button" className="suggestion" disabled={disabled}
              aria-pressed={draft === text} onClick={() => onPrompt(text)}>
              <Icon size={15} aria-hidden="true" />
              <span>{text}</span>
              <ArrowUpRight size={13} className="suggestion-arrow" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
