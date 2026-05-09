import * as fs from "node:fs";
import { resolveDataDir } from "@openacme/config";
import { logPath } from "../lifecycle/index.js";

interface LogsOpts {
  dataDir?: string;
  follow?: boolean;
  tail?: string;
}

const DEFAULT_TAIL_LINES = 200;

function tailLines(filePath: string, lines: number): { content: string; size: number } {
  if (!fs.existsSync(filePath)) return { content: "", size: 0 };
  const content = fs.readFileSync(filePath, "utf-8");
  const all = content.split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const sliced = all.slice(-lines).join("\n");
  return { content: sliced, size: Buffer.byteLength(content, "utf-8") };
}

export async function logsCommand(opts: LogsOpts): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const lp = logPath(dataDir);
  if (!fs.existsSync(lp)) {
    console.error(`No log file at ${lp} (daemon never started here)`);
    process.exit(1);
  }
  const tailN = opts.tail ? Number.parseInt(opts.tail, 10) : DEFAULT_TAIL_LINES;
  const initial = tailLines(lp, Number.isFinite(tailN) ? tailN : DEFAULT_TAIL_LINES);
  if (initial.content) console.log(initial.content);

  if (!opts.follow) return;

  // Follow mode: poll the file size every 250ms and read incrementally.
  // Watching the parent dir handles log rotation across rename; size shrink
  // means truncation/rotation, so we reopen from 0.
  let position = initial.size;
  const stop = () => process.exit(0);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const tick = async (): Promise<void> => {
    try {
      const stat = fs.statSync(lp);
      if (stat.size < position) {
        // File rotated/truncated — reopen from start.
        position = 0;
      }
      if (stat.size > position) {
        const fd = fs.openSync(lp, "r");
        const buf = Buffer.alloc(stat.size - position);
        fs.readSync(fd, buf, 0, buf.length, position);
        fs.closeSync(fd);
        process.stdout.write(buf);
        position = stat.size;
      }
    } catch {
      // log file may have been rotated out from under us — try again next tick
    }
  };

  // setInterval keeps the event loop alive — no extra unref dance needed.
  setInterval(tick, 250);
}
