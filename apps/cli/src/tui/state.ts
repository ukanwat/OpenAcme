import type { UIMessage } from "@openacme/agent-core";
import type { TokenUsage } from "@openacme/agent-core";

/** Pending attachment staged in the input bar before the next send. */
export interface PendingAttachment {
  /** Absolute path on disk (the CLI runs in-process — no upload). */
  sourcePath: string;
  filename: string;
  mediaType: string;
  size: number;
  kind: "image" | "file";
}

export interface AppState {
  /**
   * Workforce IA: the TUI lands on the sessions list (mirrors the web
   * home page) and chat is a sub-view entered by picking a session or
   * starting a new chat. Esc / `/sessions` returns to the list.
   */
  view: "sessions" | "chat";
  agentId: string;
  agentName: string;
  modelLabel: string;
  sessionId: string;
  /** Persisted UIMessages for this session (loaded from DB or appended live). */
  committed: UIMessage[];
  /** The assistant UIMessage being assembled by the live stream. */
  inflight: UIMessage | null;
  status: "idle" | "streaming" | "error";
  totalTokens: number;
  showHelp: boolean;
  paletteOpen: boolean;
  modelPickerOpen: boolean;
  agentPickerOpen: boolean;
  skillsOverlayOpen: boolean;
  mcpOverlayOpen: boolean;
  tasksOverlayOpen: boolean;
  pendingAttachments: PendingAttachment[];
  /** Transient one-shot notice — path-not-found, etc. */
  attachNotice?: string;
  lastError?: string;
}

export type Action =
  | { type: "user-submit"; message: UIMessage }
  | { type: "stream-start"; assistantId: string }
  | { type: "stream-text-delta"; text: string }
  | { type: "stream-tool-input-start"; toolCallId: string; toolName: string }
  | {
      type: "stream-tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "stream-tool-result";
      toolCallId: string;
      output: unknown;
    }
  | { type: "stream-error"; error: string }
  | {
      type: "stream-done";
      responseMessage: UIMessage | null;
      usage?: TokenUsage;
    }
  | { type: "new-session" }
  | { type: "clear" }
  | { type: "show-help" }
  | { type: "close-overlays" }
  | { type: "open-model-picker" }
  | { type: "open-agent-picker" }
  | { type: "open-skills-overlay" }
  | { type: "open-mcp-overlay" }
  | { type: "open-tasks-overlay" }
  | { type: "open-palette" }
  | { type: "enter-sessions" }
  | { type: "attach-add"; attachment: PendingAttachment }
  | { type: "attach-remove"; sourcePath: string }
  | { type: "attach-clear" }
  | { type: "attach-notice"; message: string }
  | { type: "set-agent"; agentId: string; agentName: string; modelLabel: string }
  | {
      type: "set-session";
      sessionId: string;
      agentId: string;
      agentName: string;
      modelLabel: string;
      committed: UIMessage[];
    }
  | { type: "set-model-label"; modelLabel: string };

function makeAssistant(id: string): UIMessage {
  return { id, role: "assistant", parts: [] } as UIMessage;
}

function appendTextDelta(parts: UIMessage["parts"], delta: string): UIMessage["parts"] {
  if (parts.length === 0)
    return [{ type: "text", text: delta } as UIMessage["parts"][number]];
  const last = parts[parts.length - 1]!;
  if ((last as { type?: string }).type === "text") {
    const merged = {
      ...(last as object),
      text: ((last as { text?: string }).text ?? "") + delta,
    } as UIMessage["parts"][number];
    return [...parts.slice(0, -1), merged];
  }
  return [...parts, { type: "text", text: delta } as UIMessage["parts"][number]];
}

function pushToolPart(
  parts: UIMessage["parts"],
  toolCallId: string,
  toolName: string,
  input: unknown,
  state: "input-streaming" | "input-available"
): UIMessage["parts"] {
  // If this toolCallId already has a part (from input-start), upgrade it.
  const idx = parts.findIndex(
    (p) =>
      typeof (p as { type?: unknown }).type === "string" &&
      (p as { type: string }).type.startsWith("tool-") &&
      (p as { toolCallId?: string }).toolCallId === toolCallId
  );
  const newPart = {
    type: `tool-${toolName}`,
    toolCallId,
    state,
    input,
  } as unknown as UIMessage["parts"][number];
  if (idx === -1) return [...parts, newPart];
  const next = [...parts];
  next[idx] = newPart;
  return next;
}

function fillToolResult(
  parts: UIMessage["parts"],
  toolCallId: string,
  output: unknown
): UIMessage["parts"] {
  return parts.map((p) => {
    const tp = p as {
      type?: string;
      toolCallId?: string;
    };
    if (
      typeof tp.type === "string" &&
      tp.type.startsWith("tool-") &&
      tp.toolCallId === toolCallId
    ) {
      return {
        ...(p as object),
        state: "output-available",
        output,
      } as UIMessage["parts"][number];
    }
    return p;
  });
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "user-submit": {
      return {
        ...state,
        committed: [...state.committed, action.message],
        inflight: null,
        status: "streaming",
        paletteOpen: false,
        pendingAttachments: [],
        attachNotice: undefined,
        lastError: undefined,
      };
    }
    case "stream-start":
      return { ...state, inflight: makeAssistant(action.assistantId) };
    case "stream-text-delta": {
      if (!state.inflight) return state;
      return {
        ...state,
        inflight: {
          ...state.inflight,
          parts: appendTextDelta(state.inflight.parts, action.text),
        } as UIMessage,
      };
    }
    case "stream-tool-input-start":
      if (!state.inflight) return state;
      return {
        ...state,
        inflight: {
          ...state.inflight,
          parts: pushToolPart(
            state.inflight.parts,
            action.toolCallId,
            action.toolName,
            undefined,
            "input-streaming"
          ),
        } as UIMessage,
      };
    case "stream-tool-call":
      if (!state.inflight) return state;
      return {
        ...state,
        inflight: {
          ...state.inflight,
          parts: pushToolPart(
            state.inflight.parts,
            action.toolCallId,
            action.toolName,
            action.input,
            "input-available"
          ),
        } as UIMessage,
      };
    case "stream-tool-result":
      if (!state.inflight) return state;
      return {
        ...state,
        inflight: {
          ...state.inflight,
          parts: fillToolResult(
            state.inflight.parts,
            action.toolCallId,
            action.output
          ),
        } as UIMessage,
      };
    case "stream-error":
      return {
        ...state,
        status: "error",
        lastError: action.error,
      };
    case "stream-done": {
      // Prefer the SDK-assembled responseMessage when available — it has
      // canonical part state ordering. Fall back to whatever we
      // accumulated in `inflight`.
      const finalized = action.responseMessage ?? state.inflight;
      // Some providers (notably OAuth-bound endpoints) only emit input/
      // output tokens and leave the SDK's `totalTokens` field undefined.
      // Derive it when missing so the status line doesn't stall at 0.
      const u = action.usage;
      const turnTokens =
        u?.totalTokens ?? (u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : 0);
      return {
        ...state,
        committed: finalized
          ? [...state.committed, finalized]
          : state.committed,
        inflight: null,
        status: state.status === "error" ? "error" : "idle",
        totalTokens: state.totalTokens + turnTokens,
      };
    }
    case "new-session":
      return {
        ...state,
        view: "chat",
        committed: [],
        inflight: null,
        sessionId: cryptoId(),
        status: "idle",
        totalTokens: 0,
        showHelp: false,
        paletteOpen: false,
        pendingAttachments: [],
        attachNotice: undefined,
        lastError: undefined,
      };
    case "enter-sessions":
      return {
        ...state,
        view: "sessions",
        showHelp: false,
        paletteOpen: false,
        modelPickerOpen: false,
        agentPickerOpen: false,
        skillsOverlayOpen: false,
        mcpOverlayOpen: false,
        tasksOverlayOpen: false,
        inflight: null,
        pendingAttachments: [],
        attachNotice: undefined,
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
        skillsOverlayOpen: false,
        mcpOverlayOpen: false,
        tasksOverlayOpen: false,
      };
    case "open-model-picker":
      return { ...state, modelPickerOpen: true, paletteOpen: false };
    case "open-agent-picker":
      return { ...state, agentPickerOpen: true, paletteOpen: false };
    case "open-skills-overlay":
      return { ...state, skillsOverlayOpen: true, paletteOpen: false };
    case "open-mcp-overlay":
      return { ...state, mcpOverlayOpen: true, paletteOpen: false };
    case "open-tasks-overlay":
      return { ...state, tasksOverlayOpen: true, paletteOpen: false };
    case "open-palette":
      return { ...state, paletteOpen: true };
    case "attach-add":
      if (
        state.pendingAttachments.some(
          (p) => p.sourcePath === action.attachment.sourcePath
        )
      ) {
        return state;
      }
      return {
        ...state,
        pendingAttachments: [...state.pendingAttachments, action.attachment],
        attachNotice: undefined,
      };
    case "attach-remove":
      return {
        ...state,
        pendingAttachments: state.pendingAttachments.filter(
          (p) => p.sourcePath !== action.sourcePath
        ),
      };
    case "attach-clear":
      return { ...state, pendingAttachments: [] };
    case "attach-notice":
      return { ...state, attachNotice: action.message };
    case "set-agent":
      return {
        ...state,
        view: "chat",
        agentId: action.agentId,
        agentName: action.agentName,
        modelLabel: action.modelLabel,
        committed: [],
        inflight: null,
        sessionId: cryptoId(),
        totalTokens: 0,
        agentPickerOpen: false,
        pendingAttachments: [],
        attachNotice: undefined,
      };
    case "set-session":
      return {
        ...state,
        view: "chat",
        agentId: action.agentId,
        agentName: action.agentName,
        modelLabel: action.modelLabel,
        sessionId: action.sessionId,
        committed: action.committed,
        inflight: null,
        status: "idle",
        totalTokens: 0,
        pendingAttachments: [],
        attachNotice: undefined,
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
  view?: "sessions" | "chat";
  committed?: UIMessage[];
}): AppState {
  return {
    view: opts.view ?? "sessions",
    agentId: opts.agentId,
    agentName: opts.agentName,
    modelLabel: opts.modelLabel,
    sessionId: opts.sessionId,
    committed: opts.committed ?? [],
    inflight: null,
    status: "idle",
    totalTokens: 0,
    showHelp: false,
    paletteOpen: false,
    modelPickerOpen: false,
    agentPickerOpen: false,
    skillsOverlayOpen: false,
    mcpOverlayOpen: false,
    tasksOverlayOpen: false,
    pendingAttachments: [],
  };
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10);
}
