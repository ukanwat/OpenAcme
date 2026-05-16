import { Box, Text } from "ink";
import React from "react";
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

function renderUserTextWithSkills(
  text: string,
  known: Set<string>
): React.ReactNode[] {
  const re = /(^|[\s(\[{])\/([a-zA-Z][\w-]*)\b/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[2];
    if (!name || !known.has(name)) continue;
    const tokenStart = m.index + (m[1] ? m[1].length : 0);
    if (tokenStart > last) {
      out.push(<Text key={`p-${key++}`}>{text.slice(last, tokenStart)}</Text>);
    }
    out.push(
      <Text key={`s-${key++}`} bold>{`/${name}`}</Text>
    );
    last = tokenStart + name.length + 1;
  }
  if (last < text.length) {
    out.push(<Text key={`p-${key++}`}>{text.slice(last)}</Text>);
  }
  return out;
}

export function MessageBubble({
  message,
  live = false,
  skillNames = [],
}: {
  message: UIMessage;
  live?: boolean;
  skillNames?: string[];
}) {
  if (message.role === "user") {
    const text = message.parts
      .filter(
        (p): p is Extract<Part, { type: "text" }> =>
          (p as { type?: unknown }).type === "text"
      )
      .map((p) => (p as { text: string }).text)
      .join("\n");
    // `/skill-name` expansions prepend one or more `[Skill: <name>] ... ---`
    // blocks. Strip them from the rendered bubble — the model still gets
    // the full text — and render any `/skill-name` tokens in the remainder
    // as bold inline references.
    let displayText = text;
    while (true) {
      const sm = displayText.match(
        /^\[Skill: ([^\]]+)\]\n\n([\s\S]*?)\n\n---\n\n([\s\S]*)$/
      );
      if (!sm) break;
      displayText = sm[3] ?? "";
    }
    const knownSkills = new Set(skillNames);
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
        {displayText && (
          <Box marginLeft={2}>
            <Text>{renderUserTextWithSkills(displayText, knownSkills)}</Text>
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
