import type { AgentManager } from "@openacme/server";

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

/**
 * Non-TTY chat path: stream-to-stdout with no Ink, used for piped stdin
 * (`echo "..." | openacme chat`) and CI contexts. Tool/error output goes
 * to stderr so redirecting stdout captures only assistant text.
 */
export async function runHeadless(
  manager: AgentManager,
  agentId: string
): Promise<void> {
  const input = (await readAllStdin()).trim();
  if (!input) {
    process.stderr.write(
      "No input. Pipe text on stdin (e.g. `echo \"hi\" | openacme chat`).\n"
    );
    process.exitCode = 1;
    return;
  }

  const sessionId = `cli-headless-${Date.now()}`;
  try {
    for await (const chunk of manager.chat(agentId, sessionId, input)) {
      switch (chunk.type) {
        case "text-delta":
          process.stdout.write(chunk.text);
          break;
        case "tool-call":
          process.stderr.write(`[tool] ${chunk.toolName}\n`);
          break;
        case "tool-result":
          // Suppress by default; available via OPENACME_DEBUG if needed.
          if (process.env["OPENACME_DEBUG"]) {
            process.stderr.write(
              `[result] ${chunk.result.slice(0, 200)}\n`
            );
          }
          break;
        case "error":
          process.stderr.write(`[error] ${chunk.error}\n`);
          process.exitCode = 1;
          break;
      }
    }
    process.stdout.write("\n");
  } catch (err) {
    process.stderr.write(
      `[error] ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exitCode = 1;
  }
}
