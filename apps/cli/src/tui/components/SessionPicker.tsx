import type { AgentDefinition } from "@openacme/config";
import { PickerList } from "./PickerList.js";

export interface SessionRow {
  id: string;
  title: string | null;
  agentId: string;
  updatedAt: number;
}

const TITLE_MAX = 60;

function timeAgo(unixSeconds: number): string {
  const s = Math.floor(Date.now() / 1000) - unixSeconds;
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function SessionPicker({
  sessions,
  agentsById,
  currentSessionId,
  onSelect,
  onCancel,
}: {
  sessions: SessionRow[];
  agentsById: Map<string, AgentDefinition>;
  currentSessionId: string;
  onSelect: (session: SessionRow) => void;
  onCancel: () => void;
}) {
  const items = sessions.map((s) => {
    const rawTitle = s.title ?? "(untitled)";
    const label =
      rawTitle.length > TITLE_MAX
        ? rawTitle.slice(0, TITLE_MAX - 1) + "…"
        : rawTitle;
    const agent = agentsById.get(s.agentId);
    const agentName = agent?.name ?? "[deleted agent]";
    return {
      key: s.id,
      label,
      hint: `${agentName} · ${timeAgo(s.updatedAt)}`,
    };
  });

  return (
    <PickerList
      title="Switch to an existing session"
      items={items}
      initialKey={currentSessionId}
      onSelect={(item) => {
        const found = sessions.find((s) => s.id === item.key);
        if (!found) return onCancel();
        onSelect(found);
      }}
      onCancel={onCancel}
    />
  );
}
