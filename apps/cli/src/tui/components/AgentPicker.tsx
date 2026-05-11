import type { AgentDefinition, ModelConfig } from "@openacme/config";
import { PickerList } from "./PickerList.js";

type ResolvedAgent = AgentDefinition & { model: ModelConfig };

export function AgentPicker({
  agents,
  currentId,
  onSelect,
  onCancel,
}: {
  agents: ResolvedAgent[];
  currentId: string;
  onSelect: (agent: ResolvedAgent) => void;
  onCancel: () => void;
}) {
  const items = agents.map((a) => ({
    key: a.id,
    label: a.name,
    // Role (paragraph-length, written for other agents/users) is the
    // useful "which one is this?" signal. Falls back to provider/model
    // when an agent's role hasn't been filled in yet.
    hint: a.role && a.role.trim().length > 0
      ? a.role
      : `${a.model.provider}/${a.model.model}`,
  }));

  return (
    <PickerList
      title="Switch agent"
      items={items}
      initialKey={currentId}
      onSelect={(item) => {
        const found = agents.find((a) => a.id === item.key);
        if (!found) return onCancel();
        onSelect(found);
      }}
      onCancel={onCancel}
    />
  );
}
