import { Box, Text } from "ink";
import type { AssistantPart, Message } from "../state.js";
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

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>{ROBOT} assistant</Text>
        {live && <Text color="cyan"> …</Text>}
      </Box>
      {message.parts.map((part, i) => (
        <PartView key={i} part={part} finalized={message.finalized} />
      ))}
      {message.error && (
        <Box marginLeft={2}>
          <Text color="red">⚠ {message.error}</Text>
        </Box>
      )}
    </Box>
  );
}

function PartView({
  part,
  finalized,
}: {
  part: AssistantPart;
  finalized: boolean;
}) {
  if (part.kind === "tool") {
    return (
      <ToolBlock
        tool={{
          toolCallId: part.toolCallId,
          name: part.name,
          args: part.args,
          result: part.result,
          status: part.status,
        }}
      />
    );
  }
  if (!part.text) return null;
  // Pre-rendered markdown is set on `done`. While streaming, show raw text.
  // Fallback to live-render if a finalized message somehow missed pre-render.
  const body = finalized
    ? part.rendered ?? renderMarkdown(part.text)
    : part.text;
  return (
    <Box marginLeft={2}>
      <Text>{body}</Text>
    </Box>
  );
}
