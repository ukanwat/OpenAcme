import * as fs from "node:fs";
import * as path from "node:path";
import {
  convertToModelMessages,
  type UIMessage,
  type ModelMessage,
  type ToolSet,
} from "ai";

/**
 * Local URL contract: `/api/attachments/<sessionId>/<attachmentId>/<filename>`.
 * The path round-trips to a relative path under <dataDir>/attachments — no
 * sidecar table required to look up where on disk an attachment lives.
 */
const ATTACHMENT_URL_RE = /^\/api\/attachments\/([^/]+)\/([^/]+)\/(.+)$/;

/** Parse an `/api/attachments/<...>` URL into a relative path under the
 *  attachments root. Returns null for any other URL shape (`data:`, http,
 *  etc) so callers know to pass through. */
export function parseAttachmentUrl(url: string): string | null {
  const m = url.match(ATTACHMENT_URL_RE);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

/**
 * Most providers can't reach `127.0.0.1` URLs, so before handing
 * UIMessages to `convertToModelMessages` we walk every FileUIPart whose
 * URL is one of ours and inline the bytes as a `data:` URL.
 *
 * Other URLs (already-data, external https) pass through unchanged.
 * Missing files yield a placeholder text part — the message still sends
 * but the model sees a clear marker instead of broken bytes.
 */
export function inlineFileAttachments(
  messages: UIMessage[],
  attachmentsRoot: string
): UIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => {
      if (p.type !== "file") return p;
      const rel = parseAttachmentUrl(p.url);
      if (!rel) return p;
      const abs = path.join(attachmentsRoot, rel);
      try {
        const bytes = fs.readFileSync(abs);
        return {
          ...p,
          url: `data:${p.mediaType};base64,${bytes.toString("base64")}`,
        };
      } catch {
        return {
          type: "text" as const,
          text: `[attachment unavailable: ${p.filename ?? rel}]`,
        };
      }
    }),
  }));
}

/**
 * Convert persisted UIMessages to ModelMessages ready for streamText.
 * Inlines local-attachment bytes first, then defers to the SDK's own
 * converter for tool-${name} / text / file mapping.
 */
export async function uiToModelMessages(
  messages: UIMessage[],
  opts: { attachmentsRoot: string; tools?: ToolSet }
): Promise<ModelMessage[]> {
  const inlined = inlineFileAttachments(messages, opts.attachmentsRoot);
  return convertToModelMessages(inlined, { tools: opts.tools });
}
