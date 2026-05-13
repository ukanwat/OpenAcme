import { Static, Box } from "ink";
import type { UIMessage } from "@openacme/agent-core";
import { MessageBubble } from "./MessageBubble.js";
import { Banner } from "./Banner.js";

type StaticItem =
  | { kind: "banner"; agentName: string; modelLabel: string }
  | { kind: "message"; msg: UIMessage };

/**
 * Renders the chat scrollback. <Static> commits past frames once and never
 * re-renders them — this is what makes character-by-character streaming
 * usable. The single in-flight assistant message renders below as a normal
 * <Box> and is the only thing that re-paints on each text-delta.
 */
export function MessageList({
  agentName,
  modelLabel,
  committed,
  inflight,
}: {
  agentName: string;
  modelLabel: string;
  committed: UIMessage[];
  inflight: UIMessage | null;
}) {
  // Hide the synthesized "system-event" user prompts that runAutonomous
  // prepends to each autonomous turn. They're scaffolding visible to
  // the model, not conversation visible to the operator. Web does the
  // same filter at MessageBubble render time; we filter at the list
  // level here since the Static renderer commits items once.
  const visible = committed.filter((m) => {
    const meta = (m as { metadata?: { kind?: string } }).metadata;
    return meta?.kind !== "autonomous_event";
  });
  const items: StaticItem[] = [
    { kind: "banner", agentName, modelLabel },
    ...visible.map<StaticItem>((msg) => ({ kind: "message", msg })),
  ];

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item, index) =>
          item.kind === "banner" ? (
            <Banner
              key="banner"
              agentName={item.agentName}
              modelLabel={item.modelLabel}
            />
          ) : (
            <MessageBubble key={`${item.msg.id}-${index}`} message={item.msg} />
          )
        }
      </Static>
      {inflight && <MessageBubble message={inflight} live />}
    </Box>
  );
}
