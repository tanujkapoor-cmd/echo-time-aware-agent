export interface Session {
  id: string;
  title: string | null;
  created_at: string;
}

export interface ChatRequest {
  session_id: string;
  message: string;
  request_id: string;
}

export interface SavedMemory {
  id: string;
  kind: "goal" | "preference" | "project" | "plan" | "commitment";
  content: string;
  observed_at: string;
  created_at: string;
  source_message_ids: string[];
  active: boolean;
  superseded_at: string | null;
}

export interface Citation {
  id: string;
  title: string;
  url: string;
  quote: string;
  published_at: string | null;
  retrieved_at: string;
  provenance: "live" | "cached" | "historical";
}

export interface Claim {
  value: string;
  observed_at: string;
  source_url: string;
}

export interface Change {
  kind: "changed" | "unchanged" | "new" | "now_unverified" | "conflicting" | "insufficient";
  subject?: string | null;
  attribute?: string | null;
  previous: Claim[];
  current: Claim[];
}

export interface ChatReply {
  message_id: string;
  answer: string;
  timestamp: string;
  citations?: Citation[];
  changes?: Change[];
  web_search_used?: boolean;
  memory_used?: boolean;
  elapsed_ms?: number;
  trace_id?: string;
  evidence_mode?: string;
  search_status?: string;
  baseline_at?: string | null;
  timing?: { search_calls?: number; provider_calls?: number };
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  response?: ChatReply | null;
}
