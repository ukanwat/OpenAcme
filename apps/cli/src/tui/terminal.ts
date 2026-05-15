/**
 * Reset the terminal viewport + scrollback so the next render lands on
 * a clean slate.
 *
 * Why we need this: Ink's `<Static>` (used by MessageList for committed
 * messages) commits rendered frames to the alt-buffer and never re-prints
 * them — that's what makes streaming fast. But when the TUI swaps the
 * visible component tree (session A → sessions list → session B, or
 * `/new` mid-chat), the previous session's static frames stay stacked
 * above the new view. The operator scrolls up and sees mixed content.
 *
 * Sequence: `2J` clears the visible viewport, `3J` erases the scrollback
 * buffer, `H` parks the cursor at home (row 0, col 0). Supported on all
 * modern terminals (iTerm2, Terminal.app, kitty, Alacritty, Windows
 * Terminal). Legacy Linux consoles ignore `3J` silently.
 */
export function resetTerminalView(
  stream: NodeJS.WriteStream = process.stdout
): void {
  stream.write("\x1b[2J\x1b[3J\x1b[H");
}
