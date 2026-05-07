import type { LanguageModel } from "ai";
import type { ModelConfig, Provider } from "@openacme/config";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Provider-specific factory functions.
 * Each returns a Vercel AI SDK LanguageModel instance.
 *
 * Mirrors the Hermes pattern of using raw OpenAI SDK + base_url swapping,
 * but with proper provider-specific packages for better type safety.
 */
const providerFactories: Record<
  Provider,
  (config: ModelConfig) => LanguageModel
> = {
  openai: (config) => {
    const provider = createOpenAI({
      apiKey: config.apiKey ?? process.env["OPENAI_API_KEY"],
      baseURL: config.baseUrl,
      headers: config.headers,
    });
    return provider(config.model);
  },

  anthropic: (config) => {
    const provider = createAnthropic({
      apiKey: config.apiKey ?? process.env["ANTHROPIC_API_KEY"],
      baseURL: config.baseUrl,
      headers: config.headers,
    });
    return provider(config.model);
  },

  google: (config) => {
    const provider = createGoogleGenerativeAI({
      apiKey: config.apiKey ?? process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
      baseURL: config.baseUrl,
      headers: config.headers,
    });
    return provider(config.model);
  },

  openrouter: (config) => {
    const provider = createOpenAICompatible({
      name: "openrouter",
      apiKey: config.apiKey ?? process.env["OPENROUTER_API_KEY"],
      baseURL: config.baseUrl ?? "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://openacme.dev",
        "X-Title": "OpenAcme Agent",
        ...config.headers,
      },
    });
    return provider(config.model);
  },

  ollama: (config) => {
    const provider = createOpenAICompatible({
      name: "ollama",
      baseURL: config.baseUrl ?? "http://localhost:11434/v1",
      headers: config.headers,
    });
    return provider(config.model);
  },

  custom: (config) => {
    if (!config.baseUrl) {
      throw new Error("Custom provider requires a baseUrl");
    }
    const provider = createOpenAICompatible({
      name: "custom",
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      headers: config.headers,
    });
    return provider(config.model);
  },
};

/**
 * Get a Vercel AI SDK LanguageModel from a ModelConfig.
 * This is the primary entry point for LLM access across the platform.
 */
export function getModel(config: ModelConfig): LanguageModel {
  const factory = providerFactories[config.provider];
  if (!factory) {
    throw new Error(`Unknown provider: ${config.provider}`);
  }
  return factory(config);
}

/**
 * Provider information for display in UI/CLI.
 */
export interface ProviderInfo {
  id: Provider;
  name: string;
  requiresApiKey: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
}

/**
 * List all supported providers.
 */
export function listProviders(): ProviderInfo[] {
  return [
    { id: "openai", name: "OpenAI", requiresApiKey: true, envVar: "OPENAI_API_KEY" },
    { id: "anthropic", name: "Anthropic", requiresApiKey: true, envVar: "ANTHROPIC_API_KEY" },
    { id: "google", name: "Google Gemini", requiresApiKey: true, envVar: "GOOGLE_GENERATIVE_AI_API_KEY" },
    { id: "openrouter", name: "OpenRouter", requiresApiKey: true, envVar: "OPENROUTER_API_KEY", defaultBaseUrl: "https://openrouter.ai/api/v1" },
    { id: "ollama", name: "Ollama (Local)", requiresApiKey: false, defaultBaseUrl: "http://localhost:11434/v1" },
    { id: "custom", name: "Custom (OpenAI-compatible)", requiresApiKey: false },
  ];
}
