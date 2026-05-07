// Shared API response types — mirrored (not imported) from server packages
// so the static export build doesn't pull node-only deps.

export interface ToolInfo {
  name: string;
  description: string;
  toolset: string;
  emoji?: string;
}

export interface ModelPreset {
  id: string;
  label: string;
  hint?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  requiresApiKey: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
  supportsOAuth?: boolean;
  models: ModelPreset[];
}
