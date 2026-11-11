import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import type { PoolClient } from "pg";
import { ServiceError } from "./types.ts";
import type { Memory, MemoryKind, Reply, Snapshot, Turn } from "./types.ts";

type Param = string | number | null;
type Query = <T>(sql: string, params?: Param[]) => Promise<T[]>;
type Transaction = <T>(work: (query: Query) => Promise<T>) => Promise<T>;
const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export function isPostgres(url: string): boolean {
  return /^postgres(?:ql)?(?:\+asyncpg)?:\/\//.test(url);
}

function sqliteQuery(db: DatabaseSync): Query {
  return async <T>(sql: string, params: Param[] = []) => {
    return db.prepare(sql).all(...params) as T[];
  };
}

function pgQuery(client: pg.Pool | PoolClient): Query {
  return async <T>(sql: string, params: Param[] = []) => {
    let index = 0;
    return (await client.query(sql.replace(/\?/g, () => "$" + ++index), params)).rows as T[];
  };
}

function iso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const utc = /^\d{4}-\d\d-\d\d /.test(value) ? value.replace(" ", "T") + "Z" : value;
  return new Date(utc).toISOString();
}

function decode<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function turnRow(row: Turn): Turn {
  return { ...row, asked_at: iso(row.asked_at), answered_at: iso(row.answered_at), response: decode(row.response) };
}

function snapshotRow(row: Snapshot): Snapshot {
  return {
    ...row, asked_at: iso(row.asked_at), retrieved_at: iso(row.retrieved_at),
    expires_at: iso(row.expires_at), claims: decode(row.claims), sources: decode(row.sources),
  };
}

function memoryRow(row: Memory): Memory {
  return {
    ...row, observed_at: iso(row.observed_at), created_at: iso(row.created_at),
    superseded_at: row.superseded_at ? iso(row.superseded_at) : null,
  };
}

export interface Session {
  id: string;
  title: string | null;
  created_at: string;
}

export interface MemoryUpdate {
  kind: MemoryKind;
  key: string;
  quote: string;
  replaces_id: string | null;
}

interface WriteTurn {
  user: string;
  session: string;
  revision: number;
  requestId: string | null;
  question: string;
  askedAt: string;
  reply: Reply;
  snapshot?: Snapshot;
  memories: MemoryUpdate[];
}

export class Store {
  private query: Query;
  private transaction: Transaction;
  private shutdown: () => Promise<void>;
  private postgres: boolean;

  private constructor(query: Query, transaction: Transaction, close: () => Promise<void>, postgres: boolean) {
    this.query = query;
    this.transaction = transaction;
    this.shutdown = close;
    this.postgres = postgres;
  }

  static async open(url: string): Promise<Store> {
    if (isPostgres(url)) {
      const pool = new pg.Pool({
        connectionString: url.replace("postgresql+asyncpg:", "postgresql:"),
        max: 8,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 8_000,
      });
      pool.on("error", () => console.error("Echo lost an idle database connection."));
      const transaction: Transaction = async work => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await work(pgQuery(client));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      };
      try {
        await transaction(async query => {
          await query("SELECT pg_advisory_xact_lock(81990214)");
          await query(schema);
        });
      } catch (error) {
        await pool.end();
        throw error;
      }
      return new Store(pgQuery(pool), transaction, () => pool.end(), true);
    }

    const sqlite = /^sqlite(?:\+aiosqlite)?:\/\/\/(.+)$/.exec(url);
    if (!sqlite) throw new Error("ECHO_DATABASE_URL must be SQLite or PostgreSQL.");
    const db = new DatabaseSync(sqlite[1] === ":memory:" ? ":memory:" : resolve(sqlite[1]));
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2500; PRAGMA journal_mode=WAL");
      db.exec(schema);
    } catch (error) {
      db.close();
      throw error;
    }
    const direct = sqliteQuery(db);
    let pending: Promise<unknown> = Promise.resolve();
    function serial<T>(run: () => Promise<T>): Promise<T> {
      const result = pending.then(run);
      pending = result.catch(() => {});
      return result;
    }
    return new Store(
      (sql, params) => serial(() => direct(sql, params)),
      work => serial(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await work(direct);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
      async () => { await pending; db.close(); },
      false,
    );
  }

  close() { return this.shutdown(); }

  private stamp(value: string): string {
    // Match the UTC string ordering used by the original SQLite database, including microseconds.
    return this.postgres ? value : value.replace("T", " ").replace("Z", "000");
  }

  async healthy() { await this.query("SELECT id FROM sessions LIMIT 1"); }

  async createSession(user: string, title: string | null, time: string): Promise<Session> {
    const id = randomUUID();
    await this.query("INSERT INTO sessions (id, user_id, title, created_at, revision) VALUES (?, ?, ?, ?, 0)",
      [id, user, title, this.stamp(time)]);
    return { id, title, created_at: time };
  }

  async sessions(user: string, limit: number, offset: number): Promise<Session[]> {
    const rows = await this.query<Session>(
      "SELECT id, title, created_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?",
      [user, limit, offset]);
    return rows.map(row => ({ ...row, created_at: iso(row.created_at) }));
  }

  async revision(user: string, session: string): Promise<number> {
    const [row] = await this.query<{ revision: number }>("SELECT revision FROM sessions WHERE id = ? AND user_id = ?", [session, user]);
    if (!row) throw new ServiceError("session_not_found", "Conversation not found.", 404);
    return row.revision;
  }

  async turns(user: string, session: string, after: number, limit: number): Promise<Turn[]> {
    await this.revision(user, session);
    return (await this.query<Turn>(
      "SELECT * FROM turns WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      [session, after, limit])).map(turnRow);
  }

  async turn(user: string, id: string): Promise<Turn | undefined> {
    const [row] = await this.query<Turn>(
      "SELECT t.* FROM turns t JOIN sessions s ON t.session_id = s.id WHERE t.id = ? AND s.user_id = ?",
      [id, user]);
    return row ? turnRow(row) : undefined;
  }

  async context(user: string, session: string, window: [string, string] | null, terms: string[],
    include: { snapshots: boolean; memories: boolean }) {
    const dateFilter = window ? " AND t.asked_at >= ? AND t.asked_at < ?" : "";
    const dates = window ? window.map(value => this.stamp(value)) : [];
    const [recent, dated, related, snapshots, memories] = await Promise.all([
      this.query<Turn>("SELECT * FROM turns WHERE session_id = ? ORDER BY sequence DESC LIMIT 12", [session]),
      window ? this.query<Turn>(
        "SELECT t.* FROM turns t JOIN sessions s ON t.session_id = s.id WHERE s.user_id = ?" + dateFilter +
        " ORDER BY t.asked_at DESC, t.id LIMIT 100", [user, ...dates]) : [],
      terms.length ? this.query<Turn>(
        "SELECT t.* FROM turns t JOIN sessions s ON t.session_id = s.id WHERE s.user_id = ? AND (" +
        terms.slice(0, 5).map(() => "LOWER(t.question) LIKE ?").join(" OR ") +
        ") ORDER BY t.asked_at DESC, t.id LIMIT 24", [user, ...terms.slice(0, 5).map(term => "%" + term + "%")]) : [],
      include.snapshots ? this.query<Snapshot>("SELECT * FROM snapshots WHERE user_id = ?" +
        (window ? " AND asked_at >= ? AND asked_at < ?" : "") +
        " ORDER BY retrieved_at DESC, id LIMIT 120", [user, ...dates]) : [],
      include.memories ? this.memories(user, null, false, 24, 0) : [],
    ]);
    return { recent: recent.map(turnRow), dated: dated.map(turnRow), related: related.map(turnRow),
      snapshots: snapshots.map(snapshotRow), memories };
  }

  async memories(user: string, kind: MemoryKind | null, superseded: boolean, limit: number, offset: number): Promise<Memory[]> {
    const filter = " WHERE user_id = ?" + (kind ? " AND kind = ?" : "") + (superseded ? "" : " AND active_key IS NOT NULL");
    return (await this.query<Memory>("SELECT * FROM memories" + filter + " ORDER BY observed_at DESC, id LIMIT ? OFFSET ?",
      [user, ...(kind ? [kind] : []), limit, offset])).map(memoryRow);
  }

  async replay(session: string, requestId: string | null, message: string, query = this.query): Promise<Reply | undefined> {
    if (!requestId) return;
    const [row] = await query<Pick<Turn, "question" | "response">>(
      "SELECT question, response FROM turns WHERE session_id = ? AND request_id = ?", [session, requestId]);
    if (!row) return;
    if (row.question !== message) throw new ServiceError("request_id_conflict", "This request ID belongs to another message.", 409);
    return decode(row.response);
  }

  async save(input: WriteTurn): Promise<Reply> {
    return this.transaction(async query => {
      const [updated] = await query<{ id: string }>(
        "UPDATE sessions SET revision = revision + 1, title = COALESCE(title, ?) " +
        "WHERE id = ? AND user_id = ? AND revision = ? RETURNING id",
        [[...input.question].slice(0, 64).join(""), input.session, input.user, input.revision]);
      if (!updated) {
        const saved = await this.replay(input.session, input.requestId, input.question, query);
        if (saved) return saved;
        throw new ServiceError("session_conflict", "Another message completed first. Retry this message.", 409);
      }
      // A retry may have reached us after the original commit but before context was read.
      const duplicate = await this.replay(input.session, input.requestId, input.question, query);
      if (duplicate) {
        await query("UPDATE sessions SET revision = ? WHERE id = ?", [input.revision, input.session]);
        return duplicate;
      }
      const userMessage = randomUUID();
      await query("INSERT INTO turns (id, session_id, request_id, sequence, user_message_id, question, asked_at, answered_at, response) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [input.reply.message_id, input.session, input.requestId, input.revision + 1, userMessage, input.question,
          this.stamp(input.askedAt), this.stamp(input.reply.timestamp), JSON.stringify(input.reply)]);
      for (const update of input.memories) {
        const slot = update.kind + ":" + update.key;
        const [active] = await query<Pick<Memory, "id" | "content">>(
          "SELECT id, content FROM memories WHERE user_id = ? AND active_key = ?" + (this.postgres ? " FOR UPDATE" : ""),
          [input.user, slot]);
        if (active && active.content === update.quote) continue;
        if (update.replaces_id && update.replaces_id !== active?.id) {
          throw new ServiceError("memory_conflict", "A saved detail changed first. Retry this message.", 409);
        }
        if (active && !update.replaces_id) continue;
        if (active) await query("UPDATE memories SET active_key = NULL, superseded_at = ? WHERE id = ?",
          [this.stamp(input.reply.timestamp), active.id]);
        const [inserted] = await query<{ id: string }>(
          "INSERT INTO memories (id, user_id, kind, key, active_key, content, observed_at, created_at, source_message_id, replaces_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, active_key) DO NOTHING RETURNING id",
          [randomUUID(), input.user, update.kind, update.key, slot, update.quote, this.stamp(input.askedAt),
            this.stamp(input.reply.timestamp), userMessage, active?.id ?? null]);
        if (!inserted) throw new ServiceError("memory_conflict", "A saved detail changed first. Retry this message.", 409);
      }
      const snapshot = input.snapshot;
      if (snapshot) await query(
        "INSERT INTO snapshots (id, user_id, session_id, question, topic_key, search_query, asked_at, retrieved_at, expires_at, answer_summary, claims, sources) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [snapshot.id, input.user, input.session, input.question, snapshot.topic_key, snapshot.search_query,
          this.stamp(snapshot.asked_at), this.stamp(snapshot.retrieved_at), this.stamp(snapshot.expires_at),
          snapshot.answer_summary, JSON.stringify(snapshot.claims), JSON.stringify(snapshot.sources)]);
      return input.reply;
    });
  }
}
