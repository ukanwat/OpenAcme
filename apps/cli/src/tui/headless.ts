import { randomUUID } from "node:crypto";
import type { AgentManager } from "@openacme/server";
import type { UIMessage } from "@openacme/agent-core";
import {
  commitAttachmentForCli,
  extractAtPaths,
  loadAttachment,
} from "./attachments.js";

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

/**
 * Non-TTY chat path: stream-to-stdout, used for piped stdin
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

  // Pull `@<path>` tokens from stdin so piped one-shots can attach files.
  const { cleaned, paths } = extractAtPaths(input);
  const sessionId = `cli-headless-${Date.now()}`;
  const fileParts: UIMessage["parts"] = [];
  for (const p of paths) {
    const result = loadAttachment(p);
    if (typeof result === "string") {
      process.stderr.write(`[attach skipped] ${p}: ${result}\n`);
      continue;
    }
    fileParts.push(
      commitAttachmentForCli(manager.attachmentsRoot, sessionId, result)
    );
  }
  const finalText = fileParts.length > 0 ? cleaned : input;

  const userMsg: UIMessage = {
    id: randomUUID(),
    role: "user",
    parts: [
      ...(finalText
        ? [{ type: "text", text: finalText } as UIMessage["parts"][number]]
        : []),
      ...fileParts,
    ],
  } as UIMessage;

  const ctrl = new AbortController();
  const onSigint = () => ctrl.abort();
  process.once("SIGINT", onSigint);
  try {
    if (!manager.sessionStore.get(sessionId)) {
      manager.sessionStore.create(agentId, { id: sessionId });
    }
    const agent = manager.getAgent(agentId);
    const result = await agent.runStream({
      sessionId,
      history: [userMsg],
      signal: ctrl.signal,
    });

    // Assemble the assistant UIMessage from fullStream events. We can't
    // rely on `result.response.messages` since that's ModelMessages.
    const assistantParts: UIMessage["parts"] = [];
    let textBuf = "";
    const flushText = () => {
      if (!textBuf) return;
      assistantParts.push({
        type: "text",
        text: textBuf,
      } as UIMessage["parts"][number]);
      textBuf = "";
    };
    for await (const part of result.fullStream) {
      const tp = part as { type?: string };
      if (tp.type === "text-delta") {
        const t = (part as { text?: string }).text ?? "";
        if (t) {
          process.stdout.write(t);
          textBuf += t;
        }
      } else if (tp.type === "tool-call") {
        flushText();
        const tc = part as {
          toolCallId: string;
          toolName: string;
          input: unknown;
        };
        process.stderr.write(`[tool] ${tc.toolName}\n`);
        assistantParts.push({
          type: `tool-${tc.toolName}`,
          toolCallId: tc.toolCallId,
          state: "input-available",
          input: tc.input,
        } as unknown as UIMessage["parts"][number]);
      } else if (tp.type === "tool-result") {
        const tr = part as { toolCallId: string; output: unknown };
        if (process.env["OPENACME_DEBUG"]) {
          const text =
            typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output ?? "");
          process.stderr.write(`[result] ${text.slice(0, 200)}\n`);
        }
        // Upgrade the matching tool part to output-available.
        const idx = assistantParts.findIndex(
          (p) =>
            (p as { toolCallId?: string }).toolCallId === tr.toolCallId
        );
        if (idx !== -1) {
          assistantParts[idx] = {
            ...(assistantParts[idx] as object),
            state: "output-available",
            output: tr.output,
          } as UIMessage["parts"][number];
        }
      } else if (tp.type === "error") {
        flushText();
        const err = (part as { error?: unknown }).error;
        process.stderr.write(
          `[error] ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exitCode = 1;
      }
    }
    flushText();
    process.stdout.write("\n");

    // Persist the user message + assembled assistant response.
    manager.messageStore.append(sessionId, {
      id: userMsg.id,
      role: "user",
      parts: userMsg.parts as unknown[],
    });
    if (assistantParts.length > 0) {
      manager.messageStore.append(sessionId, {
        id: randomUUID(),
        role: "assistant",
        parts: assistantParts as unknown[],
      });
    }
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      process.stderr.write("\n[stopped]\n");
      process.exitCode = 130;
    } else {
      process.stderr.write(
        `[error] ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
