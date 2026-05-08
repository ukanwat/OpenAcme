import { Box, Text } from "ink";

export function StatusLine({
  modelLabel,
  sessionId,
  totalTokens,
  status,
}: {
  modelLabel: string;
  sessionId: string;
  totalTokens: number;
  status: "idle" | "streaming" | "error";
}) {
  const indicator =
    status === "streaming"
      ? <Text color="cyan">● streaming</Text>
      : status === "error"
        ? <Text color="red">● error</Text>
        : <Text color="green">● idle</Text>;

  const sessionShort = sessionId.slice(0, 8);
  const tokens = totalTokens > 0 ? totalTokens.toLocaleString() : "0";

  return (
    <Box paddingX={1} marginTop={0}>
      <Text dimColor>{modelLabel}</Text>
      <Text dimColor> · </Text>
      <Text dimColor>session:{sessionShort}</Text>
      <Text dimColor> · </Text>
      <Text dimColor>tokens:{tokens}</Text>
      <Text dimColor> · </Text>
      {indicator}
    </Box>
  );
}
