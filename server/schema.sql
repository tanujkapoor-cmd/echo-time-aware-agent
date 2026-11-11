-- Compatible with the original Echo SQLite and PostgreSQL tables.
CREATE TABLE IF NOT EXISTS sessions (
  id varchar(36) PRIMARY KEY, user_id varchar(128) NOT NULL, title varchar(120),
  created_at timestamptz NOT NULL, revision integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sessions_user_created ON sessions(user_id, created_at, id);

CREATE TABLE IF NOT EXISTS turns (
  id varchar(36) PRIMARY KEY,
  session_id varchar(36) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id varchar(36), sequence integer NOT NULL, user_message_id varchar(36) NOT NULL UNIQUE,
  question text NOT NULL, asked_at timestamptz NOT NULL, answered_at timestamptz NOT NULL,
  response json NOT NULL, UNIQUE(session_id, request_id), UNIQUE(session_id, sequence)
);
CREATE INDEX IF NOT EXISTS ix_turns_asked_at ON turns(asked_at, session_id);

CREATE TABLE IF NOT EXISTS memories (
  id varchar(36) PRIMARY KEY, user_id varchar(128) NOT NULL,
  kind varchar(24) NOT NULL, key varchar(80) NOT NULL, active_key varchar(110),
  content text NOT NULL, observed_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
  source_message_id varchar(36) NOT NULL REFERENCES turns(user_message_id) ON DELETE CASCADE,
  superseded_at timestamptz, replaces_id varchar(36) REFERENCES memories(id),
  CHECK ((active_key IS NULL AND superseded_at IS NOT NULL) OR
         (active_key IS NOT NULL AND superseded_at IS NULL)),
  UNIQUE(user_id, active_key)
);
CREATE INDEX IF NOT EXISTS ix_memories_user_observed ON memories(user_id, observed_at, id);

CREATE TABLE IF NOT EXISTS snapshots (
  id varchar(36) PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE, user_id varchar(128) NOT NULL,
  session_id varchar(36) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question text NOT NULL, topic_key varchar(180) NOT NULL, search_query varchar(400) NOT NULL,
  asked_at timestamptz NOT NULL, retrieved_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  answer_summary text NOT NULL, claims json NOT NULL, sources json NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_snapshots_session_observed ON snapshots(session_id, retrieved_at, id);
CREATE INDEX IF NOT EXISTS ix_snapshots_user_observed ON snapshots(user_id, retrieved_at, id);
CREATE INDEX IF NOT EXISTS ix_snapshots_user_topic ON snapshots(user_id, topic_key, retrieved_at);
