import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { databaseFile, draft, harness, hit, plan, send, session } from "./harness.ts";

test("opens SQLite rows with the legacy SQLAlchemy timestamp and reply formats", async () => {
  const database = await databaseFile();
  const id = randomUUID();
  const turn = randomUUID();
  const raw = new DatabaseSync(database.slice("sqlite:///".length));
  raw.exec("CREATE TABLE sessions (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(128) NOT NULL, title VARCHAR(120), created_at DATETIME NOT NULL, revision INTEGER NOT NULL)");
  raw.exec("CREATE TABLE turns (id VARCHAR(36) PRIMARY KEY, session_id VARCHAR(36) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, request_id VARCHAR(36), sequence INTEGER NOT NULL, user_message_id VARCHAR(36) NOT NULL UNIQUE, question TEXT NOT NULL, asked_at DATETIME NOT NULL, answered_at DATETIME NOT NULL, response JSON NOT NULL, UNIQUE(session_id, sequence), UNIQUE(session_id, request_id))");
  const timestamp = "2026-11-03 05:16:30.123456";
  raw.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run(id, "local-demo", "Existing session", timestamp, 1);
  raw.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(turn, id, null, 1, randomUUID(),
    "Which database did we choose?", timestamp, timestamp, JSON.stringify({ message_id: turn, answer: "PostgreSQL.", citations: [] }));
  raw.close();

  const fixture = harness();
  const app = await fixture.open(database);
  try {
    const listed = await app.inject({ url: "/api/v1/sessions" });
    assert.equal(listed.json()[0].created_at, "2026-11-03T05:16:30.123Z");
    const old = await app.inject({ url: "/api/v1/sessions/" + id + "/messages" });
    assert.equal(old.json()[1].content, "PostgreSQL.");
    await send(app, id, "Explain binary search.");
    const all = await app.inject({ url: "/api/v1/sessions/" + id + "/messages" });
    assert.equal(all.json().length, 4);
  } finally { await app.close(); }
});

test("PostgreSQL stores and reloads a real research snapshot through the API", {
  skip: process.env.ECHO_TEST_POSTGRES_URL ? false : "set ECHO_TEST_POSTGRES_URL to a disposable PostgreSQL database",
}, async () => {
  const database = process.env.ECHO_TEST_POSTGRES_URL!;
  const fixture = harness("2026-11-03T10:00:00Z");
  const source = hit("Python.org", "https://python.org/downloads/", "The latest stable Python version is 3.14.2.");
  const evidence = draft([{ source, subject: "Python", attribute: "stable version", value: "3.14.2" }]);
  const query = "Python stable version";
  fixture.plans.push(plan(query));
  fixture.searches.set(query, [source]);
  fixture.results.push(evidence);
  let app = await fixture.open(database, "a test PostgreSQL signing secret of 32 bytes");
  const old = await session(app);
  const first = await send(app, old.id, "What is the latest stable Python version?", "UTC", randomUUID(), old.cookie);
  await app.close();
  fixture.at("2026-11-11T10:00:00Z");
  app = await fixture.open(database, "a test PostgreSQL signing secret of 32 bytes");
  try {
    const next = await session(app, old.cookie);
    fixture.results.push(evidence);
    const reply = await send(app, next.id, "What did I ask you on 3 November? Is your answer still correct today?",
      "UTC", randomUUID(), old.cookie);
    assert.equal(reply.baseline_at, first.citations[0].retrieved_at);
    assert.equal(reply.changes[0].kind, "unchanged");
    assert.deepEqual(reply.citations.map(citation => citation.provenance).sort(), ["historical", "live"]);
  } finally { await app.close(); }
});
