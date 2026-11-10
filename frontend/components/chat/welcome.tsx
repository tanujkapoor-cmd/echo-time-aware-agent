import { ArrowUpRight, Braces, Code2, GitBranch } from "lucide-react";

const prompts = [
  { category: "Live research", icon: Code2, text: "What is the latest stable Python release?" },
  { category: "Release check", icon: Braces, text: "What is the latest stable Node.js release?" },
  { category: "Quick explanation", icon: GitBranch, text: "Explain how binary search works." },
];

export function Welcome({ draft, disabled, onPrompt }: {
  draft: string;
  disabled: boolean;
  onPrompt: (text: string) => void;
}) {
  return (
    <div className="welcome">
      <section className="welcome-intro">
        <svg className="signal-art" aria-hidden="true" viewBox="0 0 600 330" fill="none">
          <defs>
            <linearGradient id="echo-signal-stroke" x1="0" y1="290" x2="580" y2="60" gradientUnits="userSpaceOnUse">
              <stop stopColor="#F4EDE0" stopOpacity="0" />
              <stop offset=".48" stopColor="#F4EDE0" stopOpacity=".37" />
              <stop offset=".8" stopColor="#FF6B5B" stopOpacity=".62" />
              <stop offset="1" stopColor="#F4EDE0" stopOpacity=".12" />
            </linearGradient>
          </defs>
          {Array.from({ length: 22 }, (_, index) => (
            <path key={index} stroke="url(#echo-signal-stroke)" strokeWidth="1"
              d={`M ${28 + index * 4} ${254 + index * 2} C ${137 + index * 3} ${320 - index * 5}, ${201 + index * 2} ${326 - index * 2}, ${294 + index * 2} ${177 + index * 3} S ${468 - index * 2} ${5 + index * 2}, ${589} ${42 + index * 8}`} />
          ))}
        </svg>
        <div className="welcome-overline eyebrow"><span className="signal-dot" aria-hidden="true" /> New conversation</div>
        <h2>How can I <em>help today?</em></h2>
        <p>Ask a question, explore an idea, or get something done with Echo.</p>
      </section>
      <section className="suggestion-section" aria-label="Suggested questions">
        <div className="suggestion-label eyebrow">Start with a question</div>
        <ul className="suggestions">
          {prompts.map(({ category, icon: Icon, text }) => (
            <li key={text}>
              <button type="button" className="suggestion" disabled={disabled}
                aria-pressed={draft === text} onClick={() => onPrompt(text)}>
                <span className="suggestion-top">
                  <Icon size={16} aria-hidden="true" />
                  <span>{category}</span>
                  <ArrowUpRight size={15} className="suggestion-arrow" aria-hidden="true" />
                </span>
                <span className="suggestion-text">{text}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
