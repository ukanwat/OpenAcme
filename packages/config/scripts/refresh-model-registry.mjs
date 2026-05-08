#!/usr/bin/env node
/**
 * Refresh `data/model-registry.json` from the public `models.dev`
 * snapshot. Build-time only — runtime never hits the network.
 *
 * `models.dev` is a community-maintained, AI SDK-aligned registry of
 * model specs (context window, costs, modalities, capability flags, …)
 * for 100+ providers. We extract the fields useful to the agent runtime:
 * context/output limits, per-token costs, modalities, and capability
 * booleans. Future code can read any of these from `lookupModelMetadata`
 * without another snapshot bump.
 *
 * Run on demand:
 *   pnpm --filter @openacme/config refresh-models
 *
 * Commit the regenerated JSON alongside the change that prompted it.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE_URL = "https://models.dev/api.json";
const OUTPUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "model-registry.json"
);

/**
 * The list of providers to include is imported from the BUILT schema
 * module so it's guaranteed to stay in sync with `ProviderSchema`. The
 * `refresh-models` package script runs `tsc --build` first to ensure
 * `dist/schema.js` is fresh before this file imports from it.
 */
const { REGISTRY_PROVIDERS } = await import("../dist/schema.js");
const SUPPORTED_PROVIDERS = new Set(REGISTRY_PROVIDERS);

function pickArray(v) {
  return Array.isArray(v) ? v : undefined;
}

function pickBool(v) {
  return typeof v === "boolean" ? v : undefined;
}

function pickNumber(v) {
  return typeof v === "number" && v > 0 ? v : undefined;
}

function pickString(v) {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Strip undefined fields so the snapshot stays compact and per-entry
 * shape variation reads cleanly in diffs.
 */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function main() {
  console.error(`Fetching ${SOURCE_URL}…`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`models.dev returned ${res.status} ${res.statusText}`);
  }
  const dump = await res.json();

  const out = {};
  let providers = 0;
  let modelsAdded = 0;

  for (const [providerKey, provider] of Object.entries(dump)) {
    if (!SUPPORTED_PROVIDERS.has(providerKey)) continue;
    if (!provider || typeof provider !== "object") continue;
    const models = provider.models;
    if (!models || typeof models !== "object") continue;
    providers++;
    for (const [modelKey, entry] of Object.entries(models)) {
      const meta = compact({
        contextWindow: pickNumber(entry?.limit?.context),
        maxOutputTokens: pickNumber(entry?.limit?.output),
        inputCostPerMTok: pickNumber(entry?.cost?.input),
        outputCostPerMTok: pickNumber(entry?.cost?.output),
        inputModalities: pickArray(entry?.modalities?.input),
        outputModalities: pickArray(entry?.modalities?.output),
        supportsAttachment: pickBool(entry?.attachment),
        supportsReasoning: pickBool(entry?.reasoning),
        supportsToolCall: pickBool(entry?.tool_call),
        supportsTemperature: pickBool(entry?.temperature),
        family: pickString(entry?.family),
        knowledgeCutoff: pickString(entry?.knowledge),
        openWeights: pickBool(entry?.open_weights),
      });
      // Skip entries with no useful fields at all.
      if (Object.keys(meta).length === 0) continue;
      const key = `${providerKey}/${modelKey}`;
      out[key] = meta;
      modelsAdded++;
    }
  }

  // Sort keys for stable diffs.
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];

  writeFileSync(OUTPUT_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf-8");
  console.error(
    `Wrote ${modelsAdded} models from ${providers} providers to ${OUTPUT_PATH}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
