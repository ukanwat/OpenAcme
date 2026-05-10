import { spawn } from "node:child_process";
import { resolveDevPorts } from "../../../scripts/lib/dev-ports.mjs";

const { proxyTarget } = resolveDevPorts();

const child = spawn(
  "pnpm",
  ["exec", "tsx", "watch", "src/index.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, OPENACME_DEV_PROXY_TARGET: proxyTarget },
  },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
