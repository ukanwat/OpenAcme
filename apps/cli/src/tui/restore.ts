import type { UIMessage } from "@openacme/agent-core";
import type { StoredUIMessage } from "@openacme/db";

/**
 * Convert persisted StoredUIMessages from the DB into the renderer's
 * UIMessage shape. Near-identity — both shapes carry `id`, `role`, `parts`.
 * Stays a function so we can adjust if the SDK's type tightens.
 */
export function dbMessagesToTuiMessages(rows: StoredUIMessage[]): UIMessage[] {
  return rows.map(
    (m) =>
      ({
        id: m.id,
        role: m.role,
        parts: m.parts as UIMessage["parts"],
        ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
      }) as UIMessage
  );
}
