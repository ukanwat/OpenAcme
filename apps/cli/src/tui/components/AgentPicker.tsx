import type { AgentDefinition } from "@openacme/config";
import { PickerList } from "./PickerList.js";

export function AgentPicker({
  agents,
  currentId,
  onSelect,
  onCancel,
}: {
  agents: AgentDefinition[];
  currentId: string;
  onSelect: (agent: AgentDefinition) => void;
  onCancel: () => void;
}) {
  const items = agents.map((a) => ({
    key: a.id,
    label: a.name,
    hint: `${a.model.provider}/${a.model.model}`,
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
