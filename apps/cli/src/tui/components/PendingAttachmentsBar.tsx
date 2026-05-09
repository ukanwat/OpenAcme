import { Box, Text } from "ink";
import type { PendingAttachment } from "../state.js";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function PendingAttachmentsBar({
  attachments,
  notice,
}: {
  attachments: PendingAttachment[];
  notice?: string;
}) {
  if (attachments.length === 0 && !notice) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {attachments.length > 0 && (
        <Box>
          <Text dimColor>attached: </Text>
          {attachments.map((a, i) => (
            <Text key={a.sourcePath} color="cyan">
              {i > 0 ? " · " : ""}
              {a.filename}
              <Text dimColor> {formatSize(a.size)}</Text>
            </Text>
          ))}
          <Text dimColor>  Ctrl+X to clear</Text>
        </Box>
      )}
      {notice && (
        <Box>
          <Text color="yellow">⚠ {notice}</Text>
        </Box>
      )}
    </Box>
  );
}
