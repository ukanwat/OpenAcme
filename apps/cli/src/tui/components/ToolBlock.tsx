import { Box, Text } from "ink";
import type { ToolEvent } from "../state.js";

const MAX_RESULT_PREVIEW = 240;

function summarizeArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args);
    if (!json || json === "{}") return "";
    return json.length > 80 ? json.slice(0, 77) + "…" : json;
  } catch {
    return "";
  }
}

function summarizeResult(result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return "(empty)";
  if (trimmed.length <= MAX_RESULT_PREVIEW) return trimmed;
  const lines = trimmed.split("\n");
  if (lines.length > 4) {
    return lines.slice(0, 4).join("\n") + `\n… +${lines.length - 4} more lines`;
  }
  return trimmed.slice(0, MAX_RESULT_PREVIEW) + "…";
}

export function ToolBlock({ tool }: { tool: ToolEvent }) {
  const argsSummary = summarizeArgs(tool.args);
  const statusGlyph =
    tool.status === "pending" ? "·" : tool.status === "error" ? "✗" : "✓";
  const statusColor =
    tool.status === "pending"
      ? "yellow"
      : tool.status === "error"
        ? "red"
        : "green";

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={0}>
      <Box>
        <Text color={statusColor}>{statusGlyph} </Text>
        <Text color="cyan">{tool.name}</Text>
        {argsSummary && <Text dimColor>({argsSummary})</Text>}
      </Box>
      {tool.result !== undefined && (
        <Box marginLeft={2}>
          <Text dimColor>{summarizeResult(tool.result)}</Text>
        </Box>
      )}
    </Box>
  );
}
