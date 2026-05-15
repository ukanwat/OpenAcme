import { render } from "ink";
import type { AgentManager } from "@openacme/server";
import type { AgentDefinition, ModelConfig } from "@openacme/config";
import { App } from "./App.js";

/**
 * Mount the Ink app for the chat REPL. Resolves only when the user exits
 * via /exit, /quit, Ctrl+C, or SIGTERM.
 */
export async function renderApp({
  manager,
  agent,
  dataDir,
}: {
  manager: AgentManager;
  agent: AgentDefinition & { model: ModelConfig };
  dataDir: string;
}): Promise<void> {
  const app = render(<App manager={manager} agent={agent} dataDir={dataDir} />);

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
