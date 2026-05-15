import { Box, Text } from "ink";
import type { UIMessage } from "@openacme/agent-core";
import { ToolBlock } from "./ToolBlock.js";
import { renderMarkdown } from "../markdown.js";

const RIGHT_ARROW = "▸";
const ROBOT = "◇";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

type Part = UIMessage["parts"][number];

function PartView({ part, finalized }: { part: Part; finalized: boolean }) {
  const tp = part as { type?: string };
  if (typeof tp.type === "string" && tp.type.startsWith("tool-")) {
    return (
      <ToolBlock
        part={part as Extract<Part, { type: `tool-${string}` }>}
        streaming={!finalized}
      />
    );
  }
  if (tp.type === "file") {
    const f = part as unknown as {
      mediaType: string;
      filename?: string;
      url: string;
    };
    // No image rendering in TTY — show a chip with filename.
    return (
      <Box marginLeft={2}>
        <Text color="cyan">[{f.filename ?? "attachment"}]</Text>
        <Text dimColor> {f.mediaType}</Text>
      </Box>
    );
  }
  if (tp.type === "text") {
    const text = (part as { text: string }).text;
    if (!text) return null;
    const body = finalized ? renderMarkdown(text) : text;
    return (
      <Box marginLeft={2}>
        <Text>{body}</Text>
      </Box>
    );
  }
  if (tp.type === "data-relevant-memory") {
    const data = (part as { data?: { entries?: Array<{ path: string; mtimeMs: number }> } }).data;
    const entries = data?.entries ?? [];
    if (entries.length === 0) return null;
    const label = entries.length === 1 ? "1 memory recalled" : `${entries.length} memories recalled`;
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text dimColor>↻ {label}</Text>
        {entries.map((e, i) => {
          const name = e.path.split("/").slice(-1)[0] ?? e.path;
          return (
            <Box key={i} marginLeft={2}>
              <Text dimColor>· {name}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }
  // Unknown / other data-* / reasoning / source — silently ignore in v1.
  return null;
}

export function MessageBubble({
  message,
  live = false,
}: {
  message: UIMessage;
  live?: boolean;
}) {
  if (message.role === "user") {
    const text = message.parts
      .filter(
        (p): p is Extract<Part, { type: "text" }> =>
          (p as { type?: unknown }).type === "text"
      )
      .map((p) => (p as { text: string }).text)
      .join("\n");
    const files = message.parts.filter(
      (p): p is Extract<Part, { type: "file" }> =>
        (p as { type?: unknown }).type === "file"
    );
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color="green" bold>
            {RIGHT_ARROW} you
          </Text>
        </Box>
        {text && (
          <Box marginLeft={2}>
            <Text>{text}</Text>
          </Box>
        )}
        {files.length > 0 && (
          <Box marginLeft={2}>
            {files.map((f, i) => {
              const part = f as unknown as {
                filename?: string;
                mediaType: string;
              };
              return (
                <Text key={i} color="cyan">
                  {i > 0 ? " · " : ""}
                  [{part.filename ?? "attachment"}{" "}
                  <Text dimColor>{part.mediaType}</Text>]
                </Text>
              );
            })}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>
          {ROBOT} assistant
        </Text>
        {live && <Text color="cyan"> …</Text>}
      </Box>
      {message.parts.map((p, i) => (
        <PartView key={i} part={p} finalized={!live} />
      ))}
    </Box>
  );
}

// Re-export the formatSize helper for the input bar (kept here so the
// chip styling is colocated with the message renderer).
export { formatSize };
