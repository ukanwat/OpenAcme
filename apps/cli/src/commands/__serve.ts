import { startServer } from "@openacme/server";

/**
 * Internal subcommand: run the server in the foreground in the current
 * process. Invoked by launchd / systemd / the noService spawn — the user
 * does not run this directly.
 *
 * Marked hidden in Commander so `--help` doesn't advertise it. The `__`
 * prefix also discourages confusion.
 */
export async function serveInternalCommand(opts: { dataDir?: string }): Promise<void> {
  await startServer(opts.dataDir);
}
