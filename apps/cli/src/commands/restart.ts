import { stopCommand } from "./stop.js";
import { startCommand } from "./start.js";

interface RestartOpts {
  dataDir?: string;
  noBrowser?: boolean;
  noService?: boolean;
}

export async function restartCommand(opts: RestartOpts): Promise<void> {
  await stopCommand({ dataDir: opts.dataDir, noService: opts.noService });
  // Brief settle time so launchd / systemd actually clears the previous
  // process before we ask it to load again.
  await new Promise((r) => setTimeout(r, 300));
  await startCommand({
    dataDir: opts.dataDir,
    noBrowser: opts.noBrowser ?? true,
    noService: opts.noService,
  });
}
