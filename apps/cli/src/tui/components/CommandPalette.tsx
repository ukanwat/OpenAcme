import { Box, Text } from "ink";
import { filterCommands } from "../commands.js";

export function CommandPalette({
  query,
  selectedIndex,
}: {
  query: string;
  selectedIndex: number;
}) {
  const matches = filterCommands(query);
  if (matches.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
    >
      {matches.map((cmd, i) => {
        const active = i === selectedIndex;
        return (
          <Box key={cmd.name}>
            <Text color={active ? "cyan" : undefined} bold={active}>
              {active ? "▸ " : "  "}/{cmd.name}
            </Text>
            {cmd.argsHint && (
              <Text dimColor> {cmd.argsHint}</Text>
            )}
            <Text dimColor>{"  · " + cmd.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
