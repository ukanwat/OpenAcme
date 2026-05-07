import { spawn } from "node:child_process";

/**
 * Open a URL in the user's default browser. Best-effort — if it fails, the
 * caller still printed the URL so the user can paste it manually.
 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => { /* swallow — URL was printed */ });
    child.unref();
  } catch {
    /* swallow — URL was printed */
  }
}

/**
 * Heuristic for "this is a headless environment" — used to suggest --device.
 * Linux/SSH session without DISPLAY is the canonical case.
 */
export function looksHeadless(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return false;
  if (process.env["SSH_CONNECTION"] || process.env["SSH_CLIENT"]) return true;
  if (!process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"]) return true;
  return false;
}
