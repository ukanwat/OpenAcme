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
  onSelect,
  onCancel,
}: {
  currentProvider: Provider;
  currentModel: string;
  onSelect: (next: { provider: Provider; model: string; label: string }) => void;
  onCancel: () => void;
}) {
  const items: (PickerItem & { provider: Provider; model: string })[] = [];
  for (const provider of PROVIDERS) {
    for (const preset of MODEL_PRESETS[provider]) {
      items.push({
        key: `${provider}/${preset.id}`,
        label: `${preset.label}`,
        hint: provider + (preset.hint ? ` · ${preset.hint}` : ""),
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
