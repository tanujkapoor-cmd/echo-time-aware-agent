import { start } from "./start.ts";

try {
  await start();
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(code ? "Echo API startup failed (" + code + ")."
    : error instanceof Error ? error.message : "Echo API startup failed.");
  process.exitCode = 1;
}
