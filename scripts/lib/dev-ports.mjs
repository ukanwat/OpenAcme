import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API_DEFAULT = 3210;
const WEB_OFFSET = 10;
const HOST = "127.0.0.1";

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolveDataDir() {
  const fromEnv = process.env.OPENACME_DATA_DIR?.trim();
  return expandHome(fromEnv || "~/.openacme");
}

function readApiPort() {
  const cfgPath = path.join(resolveDataDir(), "config.yaml");
  if (!fs.existsSync(cfgPath)) return API_DEFAULT;
  let inServer = false;
  for (const line of fs.readFileSync(cfgPath, "utf-8").split(/\r?\n/)) {
    if (/^server:\s*$/.test(line)) { inServer = true; continue; }
    if (/^\S/.test(line)) inServer = false;
    if (inServer) {
      const m = line.match(/^\s+port:\s*(\d+)/);
      if (m) return Number(m[1]);
    }
  }
  return API_DEFAULT;
}

export function resolveDevPorts() {
  const apiPort = readApiPort();
  const webPort = apiPort + WEB_OFFSET;
  return { host: HOST, apiPort, webPort, proxyTarget: `http://${HOST}:${webPort}` };
}
