import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";

export interface PickerItem {
  key: string;
  label: string;
  hint?: string;
  /** Optional prefix rendered in cyan before the label (e.g., agent name). */
  prefix?: string;
}

const DEFAULT_PAGE_SIZE = 10;

/**
 * Generic single-select overlay used by ModelPicker / AgentPicker.
 *
 * - Up/Down: move one row, clamped at top/bottom (no wrap).
 * - PageUp/PageDown: jump a page.
 * - Home/End: jump to first/last.
 * - Enter: select; Escape: cancel.
 *
 * Long lists are windowed: only `pageSize` rows render at a time, with
 * "↑ N hidden" / "↓ N hidden" markers so the latest items are always
 * visible at the top of the viewport instead of being pushed off-screen
 * by terminal scrolling.
 */
export function PickerList({
  title,
  items,
  initialKey,
  onSelect,
  onCancel,
  pageSize = DEFAULT_PAGE_SIZE,
}: {
  title: string;
  items: PickerItem[];
  initialKey?: string;
  onSelect: (item: PickerItem) => void;
  onCancel: () => void;
  pageSize?: number;
}) {
  const initialIndex = useMemo(() => {
    if (!initialKey) return 0;
    const i = items.findIndex((it) => it.key === initialKey);
    return i === -1 ? 0 : i;
  }, [items, initialKey]);
  const [index, setIndex] = useState(initialIndex);

  // Sliding window: keep the active row inside [windowStart, windowStart+pageSize).
  const windowStart = useMemo(() => {
    if (items.length <= pageSize) return 0;
    const half = Math.floor(pageSize / 2);
    const desired = index - half;
    const max = items.length - pageSize;
    return Math.max(0, Math.min(desired, max));
  }, [index, items.length, pageSize]);
  const windowEnd = Math.min(items.length, windowStart + pageSize);
  const hiddenAbove = windowStart;
  const hiddenBelow = items.length - windowEnd;

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
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(items.length - 1, i + 1));
      return;
    }
    if (key.pageUp) {
      setIndex((i) => Math.max(0, i - pageSize));
      return;
    }
    if (key.pageDown) {
      setIndex((i) => Math.min(items.length - 1, i + pageSize));
      return;
    }
  });

  const visible = items.slice(windowStart, windowEnd);

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
        <Text dimColor>
          {"   ↑↓ move · PgUp/PgDn page · Enter confirm · Esc cancel"}
        </Text>
      </Box>
      {items.length === 0 ? (
        <Text dimColor>(none available)</Text>
      ) : (
        <>
          {hiddenAbove > 0 && (
            <Text dimColor>↑ {hiddenAbove} more above</Text>
          )}
          {visible.map((item, vi) => {
            const i = windowStart + vi;
            const active = i === index;
            return (
              <Box key={item.key}>
                <Text color={active ? "cyan" : undefined} bold={active}>
                  {active ? "▸ " : "  "}
                </Text>
                {item.prefix && (
                  <Text color="cyan" dimColor={!active}>
                    [{item.prefix}]{" "}
                  </Text>
                )}
                <Text color={active ? "cyan" : undefined} bold={active}>
                  {item.label}
                </Text>
                {item.hint && <Text dimColor> · {item.hint}</Text>}
              </Box>
            );
          })}
          {hiddenBelow > 0 && (
            <Text dimColor>↓ {hiddenBelow} more below</Text>
          )}
          <Text dimColor>
            {`${index + 1} / ${items.length}`}
          </Text>
        </>
      )}
    </Box>
  );
}
