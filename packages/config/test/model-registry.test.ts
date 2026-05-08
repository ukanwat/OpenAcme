import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  lookupModelMetadata,
  REGISTRY_PROVIDERS,
  type ModelConfig,
} from "../src/index.js";

/**
 * The snapshot is bundled from https://models.dev/api.json. We test that
 * common provider/model combinations are findable and that the lookup
 * fallbacks (provider-prefixed → bare → versioned-prefix) work as
 * documented. We don't test specific contextWindow values because those
 * change as models.dev updates upstream.
 */

function model(provider: ModelConfig["provider"], id: string): ModelConfig {
  return { provider, model: id, auth: "api_key" };
}

describe("lookupModelMetadata (bundled snapshot)", () => {
  it("finds anthropic claude-opus by provider-qualified key", () => {
    const meta = lookupModelMetadata(model("anthropic", "claude-opus-4-5"));
    expect(meta.contextWindow).toBeGreaterThan(100_000);
  });

  it("finds openai gpt-4o", () => {
    const meta = lookupModelMetadata(model("openai", "gpt-4o"));
    expect(meta.contextWindow).toBeGreaterThan(100_000);
  });

  it("matches versioned ids via prefix (claude-opus-4-5-20251101)", () => {
    const meta = lookupModelMetadata(model("anthropic", "claude-opus-4-5-20251101"));
    expect(meta.contextWindow).toBeGreaterThan(100_000);
  });

  it("returns empty {} for unknown model", () => {
    expect(
      lookupModelMetadata(model("custom", "totally-fake-local-model-xyz123"))
    ).toEqual({});
  });

  it("bundled snapshot only contains REGISTRY_PROVIDERS keys (no drift)", () => {
    const path = join(__dirname, "..", "data", "model-registry.json");
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    const allowed = new Set<string>(REGISTRY_PROVIDERS);
    const offenders: string[] = [];
    for (const key of Object.keys(data)) {
      const provider = key.split("/")[0]!;
      if (!allowed.has(provider)) offenders.push(key);
    }
    expect(offenders).toEqual([]);
  });

  it("captures more than just contextWindow when models.dev has it", () => {
    const meta = lookupModelMetadata(model("anthropic", "claude-opus-4-5"));
    // Beyond contextWindow, models.dev provides cost, modalities, capability
    // flags, family — we extract them so future features (cost display,
    // multimodal routing) don't need another snapshot bump.
    expect(meta.maxOutputTokens).toBeGreaterThan(0);
    expect(meta.inputCostPerMTok).toBeGreaterThanOrEqual(0);
    expect(meta.outputCostPerMTok).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(meta.inputModalities)).toBe(true);
    expect(meta.inputModalities).toContain("text");
    expect(typeof meta.supportsToolCall).toBe("boolean");
    expect(typeof meta.family).toBe("string");
  });

  it("openrouter routes through to underlying anthropic id", () => {
    // models.dev's `openrouter` provider lists `anthropic/...` ids;
    // provider-prefix lookup finds them.
    const meta = lookupModelMetadata(
      model("openrouter", "anthropic/claude-3.7-sonnet")
    );
    expect(meta.contextWindow).toBeGreaterThanOrEqual(100_000);
  });
});
