import { MODEL_PRESETS } from "@openacme/llm-provider";
import type { Provider } from "@openacme/config";
import { PickerList, type PickerItem } from "./PickerList.js";

const PROVIDERS: Provider[] = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "ollama",
  "custom",
];

export function ModelPicker({
  currentProvider,
  currentModel,
  configured,
  onSelect,
  onCancel,
}: {
  currentProvider: Provider;
  currentModel: string;
  configured: Record<string, boolean>;
  onSelect: (next: { provider: Provider; model: string; label: string }) => void;
  onCancel: () => void;
}) {
  const items: (PickerItem & { provider: Provider; model: string })[] = [];
  for (const provider of PROVIDERS) {
    // Hide providers without credentials, but always keep the agent's current
    // provider so `initialKey` matches and the user can see what's selected.
    const isCurrent = provider === currentProvider;
    if (!configured[provider] && !isCurrent) continue;
    const unconfigured = !configured[provider];
    for (const preset of MODEL_PRESETS[provider]) {
      const baseHint = provider + (preset.hint ? ` · ${preset.hint}` : "");
      items.push({
        key: `${provider}/${preset.id}`,
        label: `${preset.label}`,
        hint: unconfigured ? `${baseHint} · no credentials` : baseHint,
        provider,
        model: preset.id,
      });
    }
  }

  return (
    <PickerList
      title="Switch model"
      items={items}
      initialKey={`${currentProvider}/${currentModel}`}
      onSelect={(item) => {
        const enriched = items.find((i) => i.key === item.key);
        if (!enriched) return onCancel();
        onSelect({
          provider: enriched.provider,
          model: enriched.model,
          label: enriched.label,
        });
      }}
      onCancel={onCancel}
    />
  );
}
