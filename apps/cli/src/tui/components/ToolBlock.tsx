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

const INTERRUPT_MARKER = "[interrupted]";

export function ToolBlock({
  part,
  streaming,
}: {
  part: ToolUIPart;
  /** True only for the bubble currently being assembled. Off-stream
   *  pending states are treated as interrupted. */
  streaming?: boolean;
}) {
  const tp = part as unknown as {
    type: string;
    state: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };
  const toolName = tp.type.slice("tool-".length);
  const argsSummary = summarizeArgs(tp.input);
  const isInterrupted =
    tp.state === "output-error" && tp.errorText === INTERRUPT_MARKER;
  const isPendingLive =
    streaming === true &&
    (tp.state === "input-streaming" || tp.state === "input-available");
  const isStaleOrphan =
    !streaming &&
    (tp.state === "input-streaming" || tp.state === "input-available");
  const isError = tp.state === "output-error" && !isInterrupted;

  const statusGlyph = isPendingLive
    ? "·"
    : isInterrupted || isStaleOrphan
      ? "⊘"
      : isError
        ? "✗"
        : "✓";
  const statusColor = isPendingLive
    ? "yellow"
    : isInterrupted || isStaleOrphan
      ? "yellow"
      : isError
        ? "red"
        : "green";
  const trailingLabel =
    isInterrupted || isStaleOrphan ? " interrupted" : "";

  const result = isError
    ? tp.errorText
    : isInterrupted || isStaleOrphan
      ? undefined
      : tp.output;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={0}>
      <Box>
        <Text color={statusColor}>{statusGlyph} </Text>
        <Text color="cyan">{toolName}</Text>
        {argsSummary && <Text dimColor>({argsSummary})</Text>}
        {trailingLabel && <Text color="yellow" dimColor>{trailingLabel}</Text>}
      </Box>
      {result !== undefined && (
        <Box marginLeft={2}>
          <Text dimColor>{summarizeResult(result)}</Text>
        </Box>
      )}
    </Box>
  );
}
