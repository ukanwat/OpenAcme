import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";
import { config as loadDotenv } from "dotenv";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Walk up from cwd looking for a `.env` file. pnpm scripts run from the
 * package directory, not the repo root — so plain `dotenv.config()` won't
 * find a repo-level `.env`. We scan up to a workspace marker (`pnpm-
 * workspace.yaml`) or filesystem root.
 */
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * OpenTelemetry bootstrap — side-effect module.
 *
 * Importing this module evaluates the gate. When `OPENACME_TELEMETRY=1` is
 * set (and `LOGFIRE_TOKEN` is present), it constructs a `NodeSDK` with an
 * OTLP exporter pointed at Logfire, registers auto-instrumentations for
 * HTTP/undici/fetch, and starts it before any other module loads. This
 * file imports zero internal config code so resolution of the
 * `./telemetry-bootstrap` exports entry never pulls in the rest of the
 * package — the dep graph stays clean and init-order safe.
 *
 * Default ships **inert** (env unset → return immediately). Production user
 * installs see no telemetry.
 */

// Load repo-root .env so the dev experience is "save token, set flag, run".
// Won't override shell-set env vars (dotenv default behavior). Different
// path than `loadConfig` which reads `<dataDir>/.env`; intentional — both
// can coexist, and the bootstrap runs before config so it can't reuse it.
const envFile = findEnvFile();
if (envFile) loadDotenv({ path: envFile });

const flag = process.env["OPENACME_TELEMETRY"];
const enabled = flag === "1" || flag === "true" || flag === "yes";

if (enabled) {
  const token = process.env["LOGFIRE_TOKEN"];
  if (!token) {
    console.warn(
      "[telemetry] OPENACME_TELEMETRY=1 but LOGFIRE_TOKEN is unset — skipping init"
    );
  } else {
    // `api-us.pydantic.dev` is the OTLP ingestion host. The
    // `logfire-{us,eu}.pydantic.dev` hosts are UI/MCP — they accept OTLP
    // requests but reject every token as "Unknown token", silently
    // swallowing telemetry. EU users override via `LOGFIRE_ENDPOINT`.
    const tracesEndpoint =
      process.env["LOGFIRE_ENDPOINT"] ??
      "https://api-us.pydantic.dev/v1/traces";
    const logsEndpoint =
      process.env["LOGFIRE_LOGS_ENDPOINT"] ??
      "https://api-us.pydantic.dev/v1/logs";
    const serviceName =
      process.env["OPENACME_TELEMETRY_SERVICE_NAME"] ?? "openacme";
    const headers = { Authorization: `Bearer ${token}` };

    const sdk = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
      }),
      traceExporter: new OTLPTraceExporter({
        url: tracesEndpoint,
        headers,
      }),
      logRecordProcessors: [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({ url: logsEndpoint, headers })
        ),
      ],
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs/dns instrumentation generates very noisy spans for an
          // LLM/CLI workload and obscures the actual provider HTTP calls
          // we care about. Keep undici (auto-traces Node 18+ fetch, which
          // Vercel AI SDK uses for OpenAI/Anthropic/OpenRouter).
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-dns": { enabled: false },
          // Server-side request tracing produces one span per /api/* call,
          // plus a tree of tcp.connect / tls.connect children. The web
          // poll cycles (/api/agents, /api/sessions, /api/home,
          // /api/messages, /api/keys, /api/mcp/status, ...) flood Logfire
          // with low-value spans. We already have the AI SDK spans
          // (ai.streamText etc.) for the chat-loop story and undici for
          // outbound provider calls. The http instrumentation also covers
          // outbound calls via the http/https module, which only matters
          // for libraries that bypass fetch (none currently).
          "@opentelemetry/instrumentation-http": { enabled: false },
        }),
      ],
    });

    sdk.start();

    // Catch stray `console.error/warn/info` from third-party libraries
    // (Vercel AI SDK retry paths, MCP transports, dotenv) and mirror them
    // into OTel logs. App code uses `@openacme/config/logger` directly —
    // pino writes to stderr, not console, so there's no double-emission
    // risk. console.log is left alone — too noisy in this codebase to
    // ship without a separate filter.
    const logger = logs.getLogger(serviceName);
    const formatArgs = (args: unknown[]): string =>
      args
        .map((a) =>
          typeof a === "string"
            ? a
            : util.inspect(a, { depth: 4, breakLength: Infinity })
        )
        .join(" ");
    const wrap =
      (
        orig: (...args: unknown[]) => void,
        severityNumber: SeverityNumber,
        severityText: string
      ) =>
      (...args: unknown[]) => {
        orig(...args);
        try {
          logger.emit({
            body: formatArgs(args),
            severityNumber,
            severityText,
          });
        } catch {
          // swallow — never let logging break the app
        }
      };
    console.error = wrap(
      console.error.bind(console),
      SeverityNumber.ERROR,
      "ERROR"
    );
    console.warn = wrap(
      console.warn.bind(console),
      SeverityNumber.WARN,
      "WARN"
    );
    console.info = wrap(
      console.info.bind(console),
      SeverityNumber.INFO,
      "INFO"
    );

    // Flush spans on exit. The server registers its own SIGINT/SIGTERM
    // handler that calls `process.exit(0)` synchronously — by registering
    // here at top-level eval (before the server module loads), our
    // `once` handlers run first and the await completes before exit.
    const flushAndExit = async (code: number) => {
      try {
        await sdk.shutdown();
      } catch {
        // swallow — we're already exiting
      }
      process.exit(code);
    };
    process.once("SIGINT", () => void flushAndExit(0));
    process.once("SIGTERM", () => void flushAndExit(0));
    process.once("beforeExit", () => {
      // Best-effort flush; can't await here without holding the loop open.
      void sdk.shutdown().catch(() => {});
    });
  }
}
