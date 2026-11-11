import { Agent, defaults } from "./agent.ts";
import { createHttpApp } from "./http.ts";
import { ChatCompletions, Tavily } from "./providers.ts";
import { isPostgres, Store } from "./store.ts";
import type { AgentSettings } from "./agent.ts";
import type { ModelConfig } from "./providers.ts";

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(name + " must be an integer between " + min + " and " + max + ".");
  }
  return value;
}

function milliseconds(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback / 1000);
  if (!Number.isFinite(value) || value <= 0 || value > max) throw new Error(name + " has an invalid duration.");
  return Math.round(value * 1000);
}

export function modelConfig(): ModelConfig {
  const provider = process.env.ECHO_LLM_PROVIDER ?? "groq";
  if (provider !== "groq" && provider !== "openai") throw new Error("Choose groq or openai for ECHO_LLM_PROVIDER.");
  const groq = provider === "groq";
  return {
    provider,
    key: (groq ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY)?.trim() ?? "",
    model: (groq ? process.env.GROQ_MODEL : process.env.OPENAI_MODEL) || (groq ? "openai/gpt-oss-20b" : "gpt-4o-mini"),
    timeout: milliseconds("ECHO_MODEL_TIMEOUT", 12_000, 120),
  };
}

export function agentConfig(): AgentSettings {
  return {
    turnTimeout: milliseconds("ECHO_TURN_TIMEOUT", defaults.turnTimeout, 180),
    searchCalls: integer("ECHO_MAX_SEARCH_CALLS", defaults.searchCalls, 1, 6),
    searchResults: integer("ECHO_MAX_SEARCH_RESULTS", defaults.searchResults, 1, 6),
    cacheSize: integer("ECHO_SEARCH_CACHE_SIZE", defaults.cacheSize, 0, 4096),
    ttl: {
      news: integer("ECHO_TTL_NEWS", defaults.ttl.news / 1000, 0, 604800) * 1000,
      market: integer("ECHO_TTL_MARKET", defaults.ttl.market / 1000, 0, 604800) * 1000,
      release: integer("ECHO_TTL_RELEASE", defaults.ttl.release / 1000, 0, 604800) * 1000,
      general: integer("ECHO_TTL_GENERAL", defaults.ttl.general / 1000, 0, 604800) * 1000,
    },
  };
}

export function searchProvider(clock: () => Date) {
  return new Tavily(process.env.TAVILY_API_KEY?.trim() ?? "", milliseconds("ECHO_SEARCH_TIMEOUT", 5_000, 60), clock);
}

export async function start() {
  const database = process.env.ECHO_DATABASE_URL ?? "sqlite:///./echo.db";
  const browserSecret = process.env.ECHO_BROWSER_SECRET;
  const publicDemo = /^(?:true|1)$/i.test(process.env.ECHO_PUBLIC_DEMO ?? "");
  if (publicDemo && (!isPostgres(database) || Buffer.byteLength(browserSecret ?? "") < 32)) {
    throw new Error("Public Echo requires PostgreSQL and a browser signing secret of at least 32 bytes.");
  }
  const frontendOrigin = process.env.ECHO_FRONTEND_ORIGIN
    ? new URL(process.env.ECHO_FRONTEND_ORIGIN) : undefined;
  if (frontendOrigin && (!["https:", "http:"].includes(frontendOrigin.protocol) ||
      frontendOrigin.href !== frontendOrigin.origin + "/")) {
    throw new Error("ECHO_FRONTEND_ORIGIN must be an HTTP(S) origin without a path.");
  }
  const clock = () => new Date();
  const model = new ChatCompletions(modelConfig());
  const provider = searchProvider(clock);
  const options = agentConfig();
  const port = process.env.PORT ? integer("PORT", 8000, 1, 65535) : integer("ECHO_API_PORT", 8000, 1, 65535);
  const host = process.env.ECHO_API_HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
  const store = await Store.open(database);
  const agent = new Agent(store, model, provider, clock, options);
  const app = createHttpApp({ agent, store, clock, browserSecret,
    localUser: process.env.ECHO_DEMO_USER, frontendOrigin: frontendOrigin?.origin,
    logger: process.env.ECHO_LOG_LEVEL?.toLowerCase() !== "silent" });
  app.addHook("onClose", async () => store.close());
  try {
    const address = await app.listen({ port, host });
    console.log("Echo Node API listening on " + address);
  } catch (error) {
    await app.close();
    throw error;
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
  }
}
