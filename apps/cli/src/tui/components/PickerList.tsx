import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface PickerItem {
  key: string;
  label: string;
  hint?: string;
}

/**
 * Generic single-select overlay used by ModelPicker / AgentPicker.
 * Up/Down to move; Enter to select; Escape to cancel.
 */
export function PickerList({
  title,
  items,
  initialKey,
  onSelect,
  onCancel,
}: {
  title: string;
  items: PickerItem[];
  initialKey?: string;
  onSelect: (item: PickerItem) => void;
  onCancel: () => void;
}) {
  const initialIndex = Math.max(
    0,
    items.findIndex((i) => i.key === initialKey)
  );
  const [index, setIndex] = useState(
    initialIndex === -1 ? 0 : initialIndex
  );

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const chosen = items[index];
      if (chosen) onSelect(chosen);
      return;
    }
    if (key.upArrow) {
      setIndex((i) => (i === 0 ? items.length - 1 : i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i === items.length - 1 ? 0 : i + 1));
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Box marginBottom={0}>
        <Text bold color="cyan">{title}</Text>
        <Text dimColor>{"   ↑↓ select · Enter confirm · Esc cancel"}</Text>
      </Box>
      {items.length === 0 ? (
        <Text dimColor>(none available)</Text>
      ) : (
        items.map((item, i) => {
          const active = i === index;
          return (
            <Box key={item.key}>
              <Text color={active ? "cyan" : undefined} bold={active}>
                {active ? "▸ " : "  "}{item.label}
              </Text>
              {item.hint && <Text dimColor> · {item.hint}</Text>}
            </Box>
          );
        })
      )}
    </Box>
  );
}
