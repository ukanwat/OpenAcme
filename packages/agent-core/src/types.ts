/**
 * Stream chunk types emitted by the agent during a conversation.
 */
export type StreamChunk =
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolName: string; args: Record<string, unknown>; toolCallId: string }
  | { type: "tool-result"; toolName: string; result: string; toolCallId: string }
  | { type: "error"; error: string }
  | { type: "done"; usage?: TokenUsage };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  model: import("@openacme/config").ModelConfig;
  persona: string;
  tools: string[];
  maxSteps: number;
  skillsIndex?: string;
}
