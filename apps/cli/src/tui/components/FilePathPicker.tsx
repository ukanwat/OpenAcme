import { Box, Text } from "ink";
import * as path from "node:path";

interface Props {
  /** The query the user typed after `@`. */
  query: string;
  /** Ranked matches (absolute paths). */
  matches: string[];
  /** Highlighted index. */
  selectedIdx: number;
  /** Used to render relative paths in the dimmed dirname column. */
  cwd: string;
}

/**
 * Inline popup for the `@<query>` fuzzy file picker. Mirrors the existing
 * CommandPalette's font/border so it doesn't drift visually.
 */
export function FilePathPicker({ query, matches, selectedIdx, cwd }: Props) {
  if (matches.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        marginBottom={1}
      >
        <Text dimColor>
          @{query}
          {"  "}
          <Text color="yellow">no matches</Text>
        </Text>
        <Text dimColor>Esc to dismiss</Text>
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Text dimColor>@{query || "(any file)"}</Text>
      {matches.map((m, i) => {
        const rel = path.relative(cwd, m) || path.basename(m);
        const dir = path.dirname(rel);
        const base = path.basename(rel);
        const isSel = i === selectedIdx;
        return (
          <Box key={m}>
            <Text color={isSel ? "cyan" : undefined} bold={isSel}>
              {isSel ? "▸ " : "  "}
              {base}
            </Text>
            {dir && dir !== "." && (
              <Text dimColor>{"  " + dir}</Text>
            )}
          </Box>
        );
      })}
      <Text dimColor>Tab/Enter to insert · ↑↓ to navigate · Esc to cancel</Text>
    </Box>
  );
}
