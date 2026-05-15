import pino, { type DestinationStream, type LevelWithSilent } from "pino";
import {
  logs,
  SeverityNumber,
  type AnyValueMap,
  type Logger as OtelLogger,
} from "@opentelemetry/api-logs";

/**
 * Workforce-wide logger.
 *
 * One shared `log` for the whole workspace. Wraps pino for terminal
 * output (JSON-line to stderr by default, or to `OPENACME_LOG_FILE` when
 * set — the TUI uses this) and emits to the global OTel logger provider
 * for Logfire. When `OPENACME_TELEMETRY` is off, the OTel emit is a
 * silent drop via the no-op global logger; the pino sink is always live.
 *
 * Use pino conventions: `log.info({ component, sessionId }, "started")`.
 * Object first, message second. Structured fields become OTel log
 * attributes — query in Logfire as `attributes->>'sessionId' = '...'`.
 * Pass `component: "<file-or-area>"` when source filtering would help.
 */

export type LogAttributes = Record<string, unknown>;

export interface AppLogger {
  // Match pino's variadic shape so callers can use either:
  //   log.info("message")
  //   log.info({ key: "val" }, "message")
  //   log.error(err)            (Error instance)
  //   log.error(err, "context")
  debug(message: string, ...args: unknown[]): void;
  debug(obj: object, message?: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  info(obj: object, message?: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  warn(obj: object, message?: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  error(obj: object | Error, message?: string, ...args: unknown[]): void;
  child(subScope: string): AppLogger;
}

// `OPENACME_DEBUG=1` / `=true` / `=auth` (or any non-empty non-zero value
// other than "false") enables debug level globally. The historical
// `=auth` sub-flag is collapsed: filter by `attributes->>'scope'` in
// Logfire instead of by env var.
const levelFromEnv = (): LevelWithSilent => {
  const v = process.env["OPENACME_DEBUG"] ?? "";
  if (v === "" || v === "0" || v === "false") return "info";
  return "debug";
};

// Pino destination is fixed at construction. The TUI sets
// `OPENACME_LOG_FILE` before any agent code runs but AFTER this module
// loads (command modules import the logger transitively), so we resolve
// lazily on first write.
let dest: DestinationStream | null = null;
const getDest = (): DestinationStream => {
  if (dest) return dest;
  const file = process.env["OPENACME_LOG_FILE"];
  dest = file
    ? pino.destination({ dest: file, sync: true, mkdir: true })
    : pino.destination(2);
  return dest;
};
const lazyWritable: DestinationStream = {
  write(chunk: string) {
    getDest().write(chunk);
  },
};

// Pino's `redact` does not walk inside `err.message` once
// `stdSerializers.err` has run. Anthropic 401s sometimes echo bearer
// tokens into the error body; scrub them out at the serializer.
const BEARER_RE = /Bearer\s+[A-Za-z0-9_\-.+/]+/g;
const errSerializer = (err: Error): object => {
  const obj = pino.stdSerializers.err(err) as Record<string, unknown>;
  if (typeof obj["message"] === "string") {
    obj["message"] = (obj["message"] as string).replace(
      BEARER_RE,
      "Bearer [REDACTED]"
    );
  }
  if (typeof obj["stack"] === "string") {
    obj["stack"] = (obj["stack"] as string).replace(
      BEARER_RE,
      "Bearer [REDACTED]"
    );
  }
  return obj;
};

// Pino's `*` is a single-level wildcard — `*.apiKey` does NOT match
// top-level `apiKey`. Need both shapes.
const REDACT_PATHS = [
  "apiKey",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "password",
  "authorization",
  "*.apiKey",
  "*.token",
  "*.access_token",
  "*.refresh_token",
  "*.id_token",
  "*.password",
  "headers.authorization",
  "headers.cookie",
  "*.headers.authorization",
  "*.headers.cookie",
];

const baseLogger = pino(
  {
    level: levelFromEnv(),
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      err: errSerializer,
    },
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
  },
  lazyWritable
);

const otelLoggerCache = new Map<string, OtelLogger>();
const getOtelLogger = (scope: string): OtelLogger => {
  let lg = otelLoggerCache.get(scope);
  if (!lg) {
    lg = logs.getLogger(scope);
    otelLoggerCache.set(scope, lg);
  }
  return lg;
};

const SEV: Record<
  "debug" | "info" | "warn" | "error",
  { num: SeverityNumber; text: string }
> = {
  debug: { num: SeverityNumber.DEBUG, text: "DEBUG" },
  info: { num: SeverityNumber.INFO, text: "INFO" },
  warn: { num: SeverityNumber.WARN, text: "WARN" },
  error: { num: SeverityNumber.ERROR, text: "ERROR" },
};

// Extract `{ body, attributes }` from a pino-style call. Mirrors pino's
// argument parsing: first arg is message string OR merging object/Error.
const extractOtel = (
  args: unknown[]
): { body: string; attributes: AnyValueMap } => {
  if (args.length === 0) return { body: "", attributes: {} };
  const first = args[0];
  const rest = args.slice(1);

  if (typeof first === "string") {
    return { body: first, attributes: {} };
  }
  if (first instanceof Error) {
    return {
      body: typeof rest[0] === "string" ? (rest[0] as string) : first.message,
      attributes: { err: errSerializer(first) as AnyValueMap },
    };
  }
  if (typeof first === "object" && first !== null) {
    const obj = { ...(first as Record<string, unknown>) };
    // If the object carries an Error under `err`, serialize it the same
    // way pino does (with token scrub).
    if (obj["err"] instanceof Error) {
      obj["err"] = errSerializer(obj["err"]) as AnyValueMap;
    }
    return {
      body: typeof rest[0] === "string" ? (rest[0] as string) : "",
      attributes: obj as AnyValueMap,
    };
  }
  return { body: String(first), attributes: {} };
};

type LogLevel = keyof typeof SEV;
// Pino's generic `Logger<>` types are awkward to compose because `.child()`
// returns a slightly different parameterization than the base. Loose-type
// the wrapper input — pino's runtime accepts any `Logger` shape.
type PinoLike = { [K in LogLevel]: (...args: unknown[]) => void };

const wrapLevel = (
  pinoLog: PinoLike,
  scope: string,
  level: LogLevel
): ((...args: unknown[]) => void) => {
  const sev = SEV[level];
  return (...args: unknown[]): void => {
    (pinoLog[level] as (...a: unknown[]) => void).apply(pinoLog, args);
    try {
      const { body, attributes } = extractOtel(args);
      getOtelLogger(scope).emit({
        body,
        severityNumber: sev.num,
        severityText: sev.text,
        attributes,
      });
    } catch {
      // never let logging break the app
    }
  };
};

/**
 * Per-module logger factory.
 *
 * Usage at top of file:
 *   import { createLogger } from "@openacme/config/logger";
 *   const log = createLogger("db.event-store");
 *
 * The scope ends up as `otel_scope_name` in Logfire records (clean source
 * filter — `WHERE otel_scope_name LIKE 'db.%'`) and on pino's terminal
 * JSON output. One line of setup per file; zero ceremony per call.
 *
 * For one-off scripts or ad-hoc use, `log` (below) is a shared singleton
 * with scope `"openacme"`. Prefer `createLogger` in package code.
 */
export function createLogger(scope: string): AppLogger {
  const pinoChild = baseLogger.child({ scope }) as unknown as PinoLike;
  const logger = {
    debug: wrapLevel(pinoChild, scope, "debug"),
    info: wrapLevel(pinoChild, scope, "info"),
    warn: wrapLevel(pinoChild, scope, "warn"),
    error: wrapLevel(pinoChild, scope, "error"),
    child(subScope: string): AppLogger {
      return createLogger(`${scope}.${subScope}`);
    },
  } as unknown as AppLogger;
  return logger;
}

/** Shared singleton for ad-hoc use; scope is `"openacme"`. */
export const log: AppLogger = createLogger("openacme");
