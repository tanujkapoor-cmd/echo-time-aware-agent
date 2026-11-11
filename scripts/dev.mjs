import concurrently from "concurrently";

const port = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(name + " must be a valid port.");
  return value;
};

const api = port("ECHO_API_PORT", process.env.PORT ?? 8000);
const web = port("ECHO_WEB_PORT", 3000);
const { result } = concurrently([
  { name: "api", command: "npm run start:api",
    env: { ...process.env, PORT: String(api), ECHO_API_HOST: "127.0.0.1" } },
  { name: "web", command: "npm run dev --workspace echo-frontend -- --port " + web,
    env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:" + api } },
], { killOthersOn: ["failure", "success"] });

try {
  await result;
} catch {
  process.exitCode = 1;
}
