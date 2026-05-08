import { Static, Box } from "ink";
import type { Message } from "../state.js";
import { MessageBubble } from "./MessageBubble.js";
import { Banner } from "./Banner.js";

type StaticItem =
  | { kind: "banner"; agentName: string; modelLabel: string }
  | { kind: "message"; msg: Message };

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
  committed: Message[];
  inflight: Message | null;
}) {
  const items: StaticItem[] = [
    { kind: "banner", agentName, modelLabel },
    ...committed.map<StaticItem>((msg) => ({ kind: "message", msg })),
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
