import { Box, Text } from "ink";
import type { UIMessage } from "@openacme/agent-core";

const MAX_RESULT_PREVIEW = 240;

type ToolUIPart = Extract<
  UIMessage["parts"][number],
  { type: `tool-${string}` }
>;

function summarizeArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args);
    if (!json || json === "{}") return "";
    return json.length > 80 ? json.slice(0, 77) + "…" : json;
  } catch {
    return "";
  }
}

function summarizeResult(output: unknown): string {
  const text =
    typeof output === "string" ? output : JSON.stringify(output ?? "");
  const trimmed = text.trim();
  if (!trimmed) return "(empty)";
  if (trimmed.length <= MAX_RESULT_PREVIEW) return trimmed;
  const lines = trimmed.split("\n");
  if (lines.length > 4) {
    return lines.slice(0, 4).join("\n") + `\n… +${lines.length - 4} more lines`;
  }
  return trimmed.slice(0, MAX_RESULT_PREVIEW) + "…";
}

export function ToolBlock({ part }: { part: ToolUIPart }) {
  const tp = part as unknown as {
    type: string;
    state: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };
  const toolName = tp.type.slice("tool-".length);
  const argsSummary = summarizeArgs(tp.input);
  const isPending =
    tp.state === "input-streaming" || tp.state === "input-available";
  const isError = tp.state === "output-error";
  const statusGlyph = isPending ? "·" : isError ? "✗" : "✓";
  const statusColor = isPending ? "yellow" : isError ? "red" : "green";
  const result = isError ? tp.errorText : tp.output;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={0}>
      <Box>
        <Text color={statusColor}>{statusGlyph} </Text>
        <Text color="cyan">{toolName}</Text>
        {argsSummary && <Text dimColor>({argsSummary})</Text>}
      </Box>
      {result !== undefined && (
        <Box marginLeft={2}>
          <Text dimColor>{summarizeResult(result)}</Text>
        </Box>
      )}
    </Box>
  );
}
