import * as fs from "node:fs";
import * as path from "node:path";
import webpush from "web-push";

const FILE_NAME = "push-vapid.json";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function vapidPath(dataDir: string): string {
  return path.join(dataDir, FILE_NAME);
}

/** Read the VAPID file. Returns null when missing — caller decides whether
 *  to generate. Malformed JSON also returns null so a corrupted file can
 *  be rebuilt without manual surgery. */
export function readVapidKeys(dataDir: string): VapidKeys | null {
  const p = vapidPath(dataDir);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<VapidKeys>;
    if (
      typeof parsed.publicKey === "string" &&
      typeof parsed.privateKey === "string" &&
      typeof parsed.subject === "string"
    ) {
      return {
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
        subject: parsed.subject,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Atomic write (tempfile → 0600 → rename). Mirrors auth.json idiom. */
export function writeVapidKeys(dataDir: string, keys: VapidKeys): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const target = vapidPath(dataDir);
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* best-effort */
    }
  }
  fs.renameSync(tmp, target);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* best-effort */
    }
  }
}

/** Read existing keys or generate and persist a new pair. Subject is
 *  required by the VAPID spec (`mailto:` URI); web-push rejects sends
 *  without one. */
export function loadOrCreateVapidKeys(
  dataDir: string,
  subjectHint?: string | null
): VapidKeys {
  const existing = readVapidKeys(dataDir);
  if (existing) return existing;
  const generated = webpush.generateVAPIDKeys();
  const subject = normalizeSubject(subjectHint);
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject,
  };
  writeVapidKeys(dataDir, keys);
  return keys;
}

/** Coerce arbitrary input to a valid `mailto:` URI. web-push requires
 *  either `mailto:` or `https:` and will throw at send time on garbage. */
function normalizeSubject(input?: string | null): string {
  const fallback = "mailto:operator@openacme.local";
  if (!input) return fallback;
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("mailto:") || trimmed.startsWith("https:")) {
    return trimmed;
  }
  if (trimmed.includes("@")) return `mailto:${trimmed}`;
  return fallback;
}
