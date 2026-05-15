import { spawn } from "node:child_process";
import { resolveDevPorts } from "../../../scripts/lib/dev-ports.mjs";

const { host, webPort } = resolveDevPorts();

const child = spawn(
  "pnpm",
  ["exec", "next", "dev", "--port", String(webPort), "--hostname", host],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
