import { startServer } from "@openacme/server";
import { exec } from "node:child_process";
import { loadConfig } from "@openacme/config";

/**
 * Open URL in default browser (cross-platform).
 */
function openBrowser(url: string) {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" :
    platform === "win32" ? "start" :
    "xdg-open";

  exec(`${cmd} ${url}`, (err) => {
    if (err) {
      console.log(`  Open in browser: ${url}`);
    }
  });
}

/**
 * Start the OpenAcme agent server.
 */
export async function startCommand(opts: { dataDir?: string; port?: string; noBrowser?: boolean }) {
  const config = loadConfig(opts.dataDir);
  const port = config.server.port;
  const host = config.server.host;
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;

  await startServer(opts.dataDir);

  // Open browser after server starts (unless --no-browser flag)
  if (!opts.noBrowser) {
    setTimeout(() => openBrowser(url), 500);
  }
}
