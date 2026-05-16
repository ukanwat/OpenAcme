import { Box, Text, useInput, usePaste } from "ink";
import { useState, useEffect, type ReactNode } from "react";
import { looksLikeDroppedPath } from "../attachments.js";

interface Props {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Captures specific keys (Esc, Tab, ArrowUp/Down) before MultilineInput consumes them. Return true to swallow. */
  onSpecialKey?: (key: { name: string; shift: boolean; ctrl: boolean; meta: boolean }) => boolean;
  /** Called when the input detects a single dropped/pasted file path.
   *  Returning true means the caller swallowed it; the buffer is left
   *  unchanged. Returning false (or undefined) lets the path fall
   *  through and be inserted as text. */
  onPastePath?: (rawPath: string) => boolean | void;
}

/**
 * Multi-line text input with cursor.
 *
 * Submission:
 *   - Enter (alone)            → submit
 *   - Shift+Enter / Ctrl+Enter / Alt+Enter → newline (terminal-dependent)
 *   - Ctrl+J                   → newline (works in every terminal — sends LF)
 *
 * Editing:
 *   - Backspace / Delete       → delete char
 *   - Left/Right arrows        → move cursor
 *   - Ctrl+A / Ctrl+E          → start / end of buffer
 *   - Any printable char       → insert at cursor (paste = single useInput call)
 */
export function MultilineInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  onSpecialKey,
  onPastePath,
}: Props) {
  const [cursor, setCursor] = useState(value.length);

  // Snap cursor when external code resets the value.
  useEffect(() => {
    if (cursor > value.length) setCursor(value.length);
  }, [value, cursor]);

  // Bracketed-paste channel — Ink 7 enables `\x1b[?2004h` while this is
  // active and delivers the FULL pasted text as one callback. Most
  // terminals route drops through bracketed paste; VS Code does NOT,
  // so this is best-effort and useInput below carries the rest.
  usePaste(
    (text) => {
      if (disabled) return;
      const cleaned = text.replace(/[\x00-\x08\x0b-\x1f]/g, "");
      if (!cleaned) return;
      const projected = value.slice(0, cursor) + cleaned + value.slice(cursor);
      if (onPastePath && looksLikeDroppedPath(projected)) {
        if (onPastePath(projected)) {
          onChange("");
          setCursor(0);
          return;
        }
      }
      onChange(value.slice(0, cursor) + cleaned + value.slice(cursor));
      setCursor(cursor + cleaned.length);
    },
    { isActive: !disabled }
  );

  useInput((input, key) => {
    if (disabled) return;

    // Let parent intercept overlay-navigation keys.
    if (onSpecialKey) {
      if (key.escape && onSpecialKey({ name: "escape", shift: !!key.shift, ctrl: !!key.ctrl, meta: !!key.meta })) return;
      if (key.tab && onSpecialKey({ name: "tab", shift: !!key.shift, ctrl: !!key.ctrl, meta: !!key.meta })) return;
      if (key.upArrow && onSpecialKey({ name: "up", shift: !!key.shift, ctrl: !!key.ctrl, meta: !!key.meta })) return;
      if (key.downArrow && onSpecialKey({ name: "down", shift: !!key.shift, ctrl: !!key.ctrl, meta: !!key.meta })) return;
    }

    // Submit on plain Enter. Multi-line ways in, in order of reliability:
    //   - `\<Enter>` (bash-style continuation) — works everywhere; the
    //     trailing backslash is consumed and replaced by a newline.
    //   - Ctrl+J — universal "insert LF" key, works in every terminal
    //     but undiscoverable without docs.
    //   - Shift / Alt / Ctrl + Enter — only fires in terminals that map
    //     the modifier through (iTerm2 + kitty yes; Terminal.app no).
    if (key.return) {
      if (key.shift || key.ctrl || key.meta) {
        insertAt("\n");
        return;
      }
      if (value.slice(0, cursor).endsWith("\\")) {
        const next =
          value.slice(0, cursor - 1) + "\n" + value.slice(cursor);
        onChange(next);
        setCursor(cursor); // backslash dropped, newline inserted in its place
        return;
      }
      onSubmit(value);
      return;
    }
    // Ctrl+J — universal "insert newline" that works in every terminal.
    if (key.ctrl && input === "\n") {
      insertAt("\n");
      return;
    }
    if (key.backspace) {
      if (cursor > 0) {
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
      }
      return;
    }
    if (key.delete) {
      if (cursor < value.length) {
        onChange(value.slice(0, cursor) + value.slice(cursor + 1));
      }
      return;
    }
    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor(Math.min(value.length, cursor + 1));
      return;
    }
    if (key.ctrl) {
      if (input === "a") setCursor(0);
      else if (input === "e") setCursor(value.length);
      else if (input === "u") {
        // kill to start of line
        const nl = value.lastIndexOf("\n", cursor - 1);
        const start = nl === -1 ? 0 : nl + 1;
        onChange(value.slice(0, start) + value.slice(cursor));
        setCursor(start);
      }
      return;
    }
    if (key.meta || key.escape) return;
    if (!input) return;
    // Filter control bytes that aren't covered above.
    const cleaned = input.replace(/[\x00-\x08\x0b-\x1f]/g, "");
    if (!cleaned) return;
    // Drag-drop in VS Code's integrated terminal bypasses bracketed
    // paste — the path arrives as a sequence of useInput chunks, so the
    // first chunk's `value.length === 0` is the only chunk that ever
    // sees an empty buffer. Instead of gating on buffer-empty, project
    // the next state and check whether the projected buffer resolves to
    // a real file. If so, the user is mid-drop and we swallow what
    // we've accumulated so far.
    if (onPastePath) {
      const projected = value.slice(0, cursor) + cleaned + value.slice(cursor);
      if (looksLikeDroppedPath(projected)) {
        if (onPastePath(projected)) {
          onChange("");
          setCursor(0);
          return;
        }
      }
    }
    insertAt(cleaned);

    function insertAt(s: string) {
      onChange(value.slice(0, cursor) + s + value.slice(cursor));
      setCursor(cursor + s.length);
    }
  });

  const safeCursor = Math.min(cursor, value.length);

  let body: ReactNode;
  if (value.length === 0) {
    body = (
      <>
        <Text inverse> </Text>
        {placeholder && <Text dimColor>{placeholder}</Text>}
      </>
    );
  } else if (safeCursor >= value.length) {
    body = (
      <>
        <Text>{value}</Text>
        <Text inverse> </Text>
      </>
    );
  } else {
    const before = value.slice(0, safeCursor);
    const at = value[safeCursor]!;
    const after = value.slice(safeCursor + 1);
    if (at === "\n") {
      body = (
        <>
          <Text>{before}</Text>
          <Text inverse> </Text>
          <Text>{"\n" + after}</Text>
        </>
      );
    } else {
      body = (
        <>
          <Text>{before}</Text>
          <Text inverse>{at}</Text>
          <Text>{after}</Text>
        </>
      );
    }
  }

  return (
    <Box>
      <Text dimColor>{"› "}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text>{body}</Text>
      </Box>
    </Box>
  );
}
