import type { StreamChunk, TokenUsage } from "@openacme/agent-core";
import { renderMarkdown } from "./markdown.js";

export type Role = "user" | "assistant";

export type AssistantPart =
  | { kind: "text"; text: string; rendered?: string }
  | {
      kind: "tool";
      toolCallId: string;
      name: string;
      args: unknown;
      result?: string;
      status: "pending" | "done" | "error";
    };

// Kept for ToolBlock's prop shape; mapped from `tool` parts at render time.
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
  parts: AssistantPart[];
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
  skillsOverlayOpen: boolean;
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
  | { type: "open-skills-overlay" }
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
    parts: [],
    finalized: false,
  };
}

function appendTextDelta(parts: AssistantPart[], delta: string): AssistantPart[] {
  const last = parts[parts.length - 1];
  if (last && last.kind === "text") {
    const merged: AssistantPart = { kind: "text", text: last.text + delta };
    return [...parts.slice(0, -1), merged];
  }
  return [...parts, { kind: "text", text: delta }];
}

function pushToolCall(
  parts: AssistantPart[],
  toolCallId: string,
  name: string,
  args: unknown
): AssistantPart[] {
  return [
    ...parts,
    { kind: "tool", toolCallId, name, args, status: "pending" },
  ];
}

function fillToolResult(
  parts: AssistantPart[],
  toolCallId: string,
  result: string
): AssistantPart[] {
  return parts.map((p) =>
    p.kind === "tool" && p.toolCallId === toolCallId
      ? { ...p, result, status: "done" as const }
      : p
  );
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
        case "text-delta": {
          const parts = appendTextDelta(inflight.parts, chunk.text);
          return {
            ...state,
            inflight: { ...inflight, parts, text: inflight.text + chunk.text },
          };
        }
        case "tool-call": {
          const parts = pushToolCall(
            inflight.parts,
            chunk.toolCallId,
            chunk.toolName,
            chunk.args
          );
          return { ...state, inflight: { ...inflight, parts } };
        }
        case "tool-result": {
          const parts = fillToolResult(
            inflight.parts,
            chunk.toolCallId,
            chunk.result
          );
          return { ...state, inflight: { ...inflight, parts } };
        }
        case "error":
          return {
            ...state,
            status: "error",
            inflight: { ...inflight, error: chunk.error },
          };
        case "stopped": {
          // User-cancelled: finalize whatever streamed so far and drop back
          // to idle. Mirrors `done` minus usage; no error styling.
          const parts = inflight.parts.map<AssistantPart>((p) =>
            p.kind === "text"
              ? { ...p, rendered: p.text ? renderMarkdown(p.text) : "" }
              : p
          );
          const finalized: Message = { ...inflight, parts, finalized: true };
          return {
            ...state,
            committed: [...state.committed, finalized],
            inflight: null,
            status: "idle",
          };
        }
        case "done": {
          // Pre-render markdown per text-part so the static frame doesn't
          // re-parse on every paint. (Each text part is a contiguous run of
          // deltas between tool calls, so it parses cleanly on its own.)
          const parts = inflight.parts.map<AssistantPart>((p) =>
            p.kind === "text"
              ? { ...p, rendered: p.text ? renderMarkdown(p.text) : "" }
              : p
          );
          const finalized: Message = {
            ...inflight,
            parts,
            usage: chunk.usage,
            finalized: true,
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
        skillsOverlayOpen: false,
      };
    case "open-model-picker":
      return { ...state, modelPickerOpen: true, paletteOpen: false };
    case "open-agent-picker":
      return { ...state, agentPickerOpen: true, paletteOpen: false };
    case "open-session-picker":
      return { ...state, sessionPickerOpen: true, paletteOpen: false };
    case "open-skills-overlay":
      return { ...state, skillsOverlayOpen: true, paletteOpen: false };
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
    skillsOverlayOpen: false,
  };
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10);
}
