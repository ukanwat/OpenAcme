import type { StreamChunk, TokenUsage } from "@openacme/agent-core";
import { renderMarkdown } from "./markdown.js";

export type Role = "user" | "assistant";

export interface ToolEvent {
  toolCallId: string;
  name: string;
  args: unknown;
  result?: string;
  status: "pending" | "done" | "error";
}

export interface Message {
  id: string;
  role: Role;
  text: string;
  rendered?: string;
  tools: ToolEvent[];
  finalized: boolean;
  usage?: TokenUsage;
  error?: string;
}

export interface AppState {
  agentId: string;
  agentName: string;
  modelLabel: string;
  sessionId: string;
  committed: Message[];
  inflight: Message | null;
  status: "idle" | "streaming" | "error";
  totalTokens: number;
  showHelp: boolean;
  paletteOpen: boolean;
  modelPickerOpen: boolean;
  agentPickerOpen: boolean;
  sessionPickerOpen: boolean;
}

export type Action =
  | { type: "user-submit"; text: string }
  | { type: "chunk"; chunk: StreamChunk }
  | { type: "stream-error"; error: string }
  | { type: "new-session" }
  | { type: "clear" }
  | { type: "show-help" }
  | { type: "close-overlays" }
  | { type: "open-model-picker" }
  | { type: "open-agent-picker" }
  | { type: "open-session-picker" }
  | { type: "open-palette" }
  | { type: "set-agent"; agentId: string; agentName: string; modelLabel: string }
  | {
      type: "set-session";
      sessionId: string;
      agentId: string;
      agentName: string;
      modelLabel: string;
      committed: Message[];
    }
  | { type: "set-model-label"; modelLabel: string };

export function makeMessage(role: Role): Message {
  return {
    id: cryptoId(),
    role,
    text: "",
    tools: [],
    finalized: false,
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "user-submit": {
      const userMsg: Message = {
        ...makeMessage("user"),
        text: action.text,
        finalized: true,
      };
      const inflight = makeMessage("assistant");
      return {
        ...state,
        committed: [...state.committed, userMsg],
        inflight,
        status: "streaming",
        paletteOpen: false,
      };
    }
    case "chunk": {
      const { chunk } = action;
      if (!state.inflight) return state;
      const inflight = state.inflight;
      switch (chunk.type) {
        case "session":
          return { ...state, sessionId: chunk.sessionId };
        case "text-delta":
          return {
            ...state,
            inflight: { ...inflight, text: inflight.text + chunk.text },
          };
        case "tool-call": {
          const tool: ToolEvent = {
            toolCallId: chunk.toolCallId,
            name: chunk.toolName,
            args: chunk.args,
            status: "pending",
          };
          return {
            ...state,
            inflight: { ...inflight, tools: [...inflight.tools, tool] },
          };
        }
        case "tool-result": {
          const tools = inflight.tools.map((t) =>
            t.toolCallId === chunk.toolCallId
              ? { ...t, result: chunk.result, status: "done" as const }
              : t
          );
          return { ...state, inflight: { ...inflight, tools } };
        }
        case "error":
          return {
            ...state,
            status: "error",
            inflight: { ...inflight, error: chunk.error },
          };
        case "done": {
          const finalized: Message = {
            ...inflight,
            usage: chunk.usage,
            finalized: true,
            rendered: inflight.text ? renderMarkdown(inflight.text) : "",
          };
          return {
            ...state,
            committed: [...state.committed, finalized],
            inflight: null,
            status: state.status === "error" ? "error" : "idle",
            totalTokens:
              state.totalTokens + (chunk.usage?.totalTokens ?? 0),
          };
        }
      }
      return state;
    }
    case "stream-error":
      return {
        ...state,
        status: "error",
        inflight: state.inflight
          ? { ...state.inflight, error: action.error, finalized: true }
          : null,
      };
    case "new-session":
      return {
        ...state,
        committed: [],
        inflight: null,
        sessionId: cryptoId(),
        status: "idle",
        totalTokens: 0,
        showHelp: false,
        paletteOpen: false,
      };
    case "clear":
      return { ...state, committed: [], inflight: null };
    case "show-help":
      return { ...state, showHelp: true, paletteOpen: false };
    case "close-overlays":
      return {
        ...state,
        showHelp: false,
        paletteOpen: false,
        modelPickerOpen: false,
        agentPickerOpen: false,
        sessionPickerOpen: false,
      };
    case "open-model-picker":
      return { ...state, modelPickerOpen: true, paletteOpen: false };
    case "open-agent-picker":
      return { ...state, agentPickerOpen: true, paletteOpen: false };
    case "open-session-picker":
      return { ...state, sessionPickerOpen: true, paletteOpen: false };
    case "open-palette":
      return { ...state, paletteOpen: true };
    case "set-agent":
      return {
        ...state,
        agentId: action.agentId,
        agentName: action.agentName,
        modelLabel: action.modelLabel,
        committed: [],
        inflight: null,
        sessionId: cryptoId(),
        totalTokens: 0,
        agentPickerOpen: false,
      };
    case "set-session":
      return {
        ...state,
        agentId: action.agentId,
        agentName: action.agentName,
        modelLabel: action.modelLabel,
        sessionId: action.sessionId,
        committed: action.committed,
        inflight: null,
        status: "idle",
        totalTokens: 0,
        sessionPickerOpen: false,
      };
    case "set-model-label":
      return {
        ...state,
        modelLabel: action.modelLabel,
        modelPickerOpen: false,
      };
    default:
      return state;
  }
}

export function initState(opts: {
  agentId: string;
  agentName: string;
  modelLabel: string;
  sessionId: string;
}): AppState {
  return {
    agentId: opts.agentId,
    agentName: opts.agentName,
    modelLabel: opts.modelLabel,
    sessionId: opts.sessionId,
    committed: [],
    inflight: null,
    status: "idle",
    totalTokens: 0,
    showHelp: false,
    paletteOpen: false,
    modelPickerOpen: false,
    agentPickerOpen: false,
    sessionPickerOpen: false,
  };
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10);
}
