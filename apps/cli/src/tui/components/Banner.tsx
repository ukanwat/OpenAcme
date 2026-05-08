import { Box, Text } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";

export function Banner({
  agentName,
  modelLabel,
}: {
  agentName: string;
  modelLabel: string;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={0}
      marginBottom={1}
    >
      <Gradient name="atlas">
        <BigText text="OpenAcme" font="tiny" />
      </Gradient>
      <Box marginTop={0}>
        <Text dimColor>
          {agentName} · <Text color="cyan">{modelLabel}</Text> · Type{" "}
          <Text color="yellow">/help</Text> for commands
        </Text>
      </Box>
    </Box>
  );
}
