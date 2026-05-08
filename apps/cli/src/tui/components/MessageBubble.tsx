import { Box, Text } from "ink";
import type { Message } from "../state.js";
import { ToolBlock } from "./ToolBlock.js";
import { renderMarkdown } from "../markdown.js";

const RIGHT_ARROW = "▸";
const ROBOT = "◇";

export function MessageBubble({
  message,
  live = false,
}: {
  message: Message;
  live?: boolean;
}) {
  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color="green" bold>{RIGHT_ARROW} you</Text>
        </Box>
        <Box marginLeft={2}>
          <Text>{message.text}</Text>
        </Box>
      </Box>
    );
  }

  // assistant
  const body = message.finalized
    ? message.rendered ?? renderMarkdown(message.text || "")
    : message.text;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>{ROBOT} assistant</Text>
        {live && <Text color="cyan"> …</Text>}
      </Box>
      {message.tools.length > 0 && (
        <Box flexDirection="column">
          {message.tools.map((t) => (
            <ToolBlock key={t.toolCallId} tool={t} />
          ))}
        </Box>
      )}
      {body && (
        <Box marginLeft={2}>
          <Text>{body}</Text>
        </Box>
      )}
      {message.error && (
        <Box marginLeft={2}>
          <Text color="red">⚠ {message.error}</Text>
        </Box>
      )}
    </Box>
  );
}
