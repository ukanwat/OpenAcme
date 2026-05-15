// Shared API response types — mirrored (not imported) from server packages
// so the static export build doesn't pull node-only deps.

import type { UIMessage } from "ai";

/**
 * Mirror of `OpenAcmeDataParts` in `@openacme/agent-core/src/types.ts`.
 * Kept in sync by hand — both sides must match for the typed `useChat`
 * onData callback (and `writer.write` server-side) to type-check
 * end-to-end. New entry here = new entry there.
 */
export interface OpenAcmeDataParts {
  session: { sessionId: string };
  status: {
    id: string;
    kind: "info" | "warn" | "error" | "compressing" | "compressed";
    message: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export type OpenAcmeUIMessage = UIMessage<
  Record<string, unknown>,
  OpenAcmeDataParts
>;

export interface ToolInfo {
  name: string;
  description: string;
  toolset: string;
  emoji?: string;
  /** Always-on tool merged into every agent regardless of the agent's
   *  `tools` config — hidden from the picker. */
  system?: boolean;
}

export interface ModelPreset {
  id: string;
  label: string;
  hint?: string;
  /** Modalities the model accepts on input — e.g. ["text", "image", "pdf"].
   *  Undefined when the bundled registry has no entry; conservatively
   *  treated as "text-only" by the file-picker gate but allowed through
   *  by the server's gate (which is itself defensive). */
  inputModalities?: string[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  requiresApiKey: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
  supportsOAuth?: boolean;
  models: ModelPreset[];
}

/** A committed attachment row as returned by /api/sessions/:id/messages
 *  and /api/uploads. The `id` is what the user-bubble image/PDF link
 *  resolves against `/api/attachments/:id`. */
export interface AttachmentRow {
  id: string;
  kind: "image" | "file";
  mediaType: string;
  size: number;
  originalName: string | null;
}

export const ALLOWED_UPLOAD_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;

export const UPLOAD_LIMITS = {
  perFileBytes: 5 * 1024 * 1024,
  perRequestBytes: 25 * 1024 * 1024,
  perRequestFiles: 10,
} as const;
