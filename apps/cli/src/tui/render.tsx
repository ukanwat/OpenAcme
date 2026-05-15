import { render } from "ink";
import type { AgentManager } from "@openacme/server";
import type { AgentDefinition, ModelConfig } from "@openacme/config";
import type { UIMessage } from "@openacme/agent-core";
import { App } from "./App.js";

/**
 * Mount the Ink app for the chat REPL. Resolves only when the user exits
 * via /exit, /quit, Ctrl+C, or SIGTERM.
 *
 * Default landing is the sessions list (`initialView: "sessions"`); pass
 * `"chat"` + `initialSessionId` / `initialCommitted` to jump straight
 * into a session (used when --agent / --session flags are present).
 */
export async function renderApp({
  manager,
  agent,
  dataDir,
  initialView,
  initialSessionId,
  initialCommitted,
}: {
  manager: AgentManager;
  agent: AgentDefinition & { model: ModelConfig };
  dataDir: string;
  initialView?: "sessions" | "chat";
  initialSessionId?: string;
  initialCommitted?: UIMessage[];
}): Promise<void> {
  const app = render(
    <App
      manager={manager}
      agent={agent}
      dataDir={dataDir}
      initialView={initialView}
      initialSessionId={initialSessionId}
      initialCommitted={initialCommitted}
    />
  );

  const onSigterm = () => {
    app.unmount();
  };
  process.once("SIGTERM", onSigterm);

  try {
    await app.waitUntilExit();
  } finally {
    process.removeListener("SIGTERM", onSigterm);
  }
}
