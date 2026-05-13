import { z } from "zod";
import { registry } from "../registry.js";
import { getCurrentAgentId, getCurrentSessionId } from "../session-context.js";

/**
 * `ping_user` — the single agent → operator attention primitive.
 *
 * Fires a `ping_user` event scoped to the current session. The
 * operator's inbox surfaces the message; resolution rule: the ping
 * stays "unresolved" until any user message in the session has a
 * later created_at. Use for questions, approvals, FYIs, credential
 * requests, anything that needs human attention. The agent's prose
 * carries the semantic — the tool itself doesn't know or care which
 * kind of ask this is.
 *
 * The tool returns immediately. The agent decides whether to end the
 * turn (typical, when blocked on the answer) or keep working on
 * independent tasks while the human responds.
 *
 * NOTE on rendering: the message text should also be the agent's
 * regular assistant response in the chat — this tool is the
 * *attention signal*, not the *content channel*. The chat pane
 * naturally surfaces the message via the assistant's own text;
 * the inbox surfaces it via the tool's stored payload. Two paths,
 * same string.
 */

export interface PingUserEventEmit {
  taskId?: string | null;
  sessionId: string;
  agentId: string;
  message: string;
}

export interface PingUserBindings {
  /** Emit a ping event. AgentManager binds this to EventStore.append
   *  with the right `kind` and payload shape. */
  emit: (event: PingUserEventEmit) => void;
}

let bindings: PingUserBindings | null = null;

export function bindPingUser(b: PingUserBindings): void {
  bindings = b;
}

const DESCRIPTION =
  "Bring the user into the loop. Use when you (a) genuinely need their input " +
  "(stuck, missing context, blocked on a credential, asking for approval on a " +
  "high-blast-radius action), or (b) have a result they specifically asked to " +
  "see, or (c) need an action only they can perform (logging into a service, " +
  "etc.). The message text carries the question / FYI / approval ask — be " +
  "specific so they can respond without re-reading the whole session.\n\n" +
  "For agent-to-agent clarification, comment on the task instead (the assigner " +
  "wakes via the event pipe). Reserve ping_user for the human boundary.\n\n" +
  "Behavior: fires immediately, no blocking. After calling it, end your turn " +
  "and wait — the user's reply lands as a regular message that wakes you on " +
  "its own.";

registry.register({
  name: "ping_user",
  toolset: "system",
  description: DESCRIPTION,
  parameters: z.object({
    message: z
      .string()
      .min(1)
      .describe(
        "What you want to tell or ask the user. Same content you'd write " +
          "as your assistant response — repeat it here so the inbox row " +
          "and the chat transcript agree."
      ),
  }),
  emoji: "🔔",
  parallelSafe: false,
  handler: async (args) => {
    const { message } = args as { message: string };
    if (!bindings) {
      return JSON.stringify({
        error:
          "ping_user not initialized — AgentManager must call bindPingUser().",
      });
    }
    const sessionId = getCurrentSessionId();
    const agentId = getCurrentAgentId();
    if (!sessionId || !agentId) {
      return JSON.stringify({
        error:
          "ping_user requires an active session + agent context (use during a turn).",
      });
    }
    try {
      bindings.emit({ sessionId, agentId, message });
      return JSON.stringify({ acknowledged: true });
    } catch (e) {
      return JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
