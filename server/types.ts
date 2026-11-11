export type Clock = () => Date;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  published_at: string | null;
  retrieved_at: string;
}

export interface Citation extends Omit<SearchHit, "snippet"> {
  id: string;
  quote: string;
  provenance: "live" | "cached" | "historical";
}

export interface PriceScope {
  plan: string;
  currency: string;
  billing: "monthly" | "annual" | "hourly" | "usage";
  unit: "seat" | "project" | "instance" | "organization" | "usage";
  market: string | null;
}

export interface Claim {
  subject: string;
  attribute: string;
  value: string;
  observed_at: string;
  source_url: string;
  quote: string;
  scope?: PriceScope | null;
}

export interface Change {
  kind: "changed" | "unchanged" | "new" | "now_unverified" | "conflicting" | "insufficient";
  subject?: string;
  attribute?: string;
  previous: Claim[];
  current: Claim[];
}

export interface Timing {
  memory_ms: number;
  llm_ms: number;
  search_ms: number;
  model_calls: number;
  search_calls: number;
  provider_calls: number;
  cache_hits: number;
  cache_misses: number;
  tokens: number | null;
}

export interface Reply {
  message_id: string;
  answer: string;
  timestamp: string;
  citations: Citation[];
  web_search_used: boolean;
  memory_used: boolean;
  evidence_mode: "model_knowledge" | "conversation" | "historical" | "live_snippets" | "cached_snippets" | "insufficient";
  search_status: "not_used" | "live" | "cached" | "unavailable" | "empty" | "unsupported";
  changes: Change[];
  baseline_at: string | null;
  trace_id: string;
  elapsed_ms: number;
  timing: Timing;
}

export interface Turn {
  id: string;
  session_id: string;
  user_message_id: string;
  request_id: string | null;
  sequence: number;
  question: string;
  asked_at: string;
  answered_at: string;
  response: Reply;
}

export interface Snapshot {
  id: string;
  user_id: string;
  session_id: string;
  question: string;
  topic_key: string;
  search_query: string;
  asked_at: string;
  retrieved_at: string;
  expires_at: string;
  answer_summary: string;
  claims: Claim[];
  sources: SearchHit[];
}

export const memoryKinds = ["goal", "preference", "project", "plan", "commitment"] as const;
export type MemoryKind = typeof memoryKinds[number];

export interface Memory {
  id: string;
  kind: MemoryKind;
  key: string;
  active_key: string | null;
  content: string;
  observed_at: string;
  created_at: string;
  source_message_id: string;
  superseded_at: string | null;
  replaces_id: string | null;
}

export class ServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
