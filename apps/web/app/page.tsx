"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  ArrowUp,
  Bot,
  MessageSquare,
  Trash2,
  Square,
  Paperclip,
} from "lucide-react";
import { toast } from "sonner";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
// `OpenAcmeUIMessage` carries our typed `data-*` parts (session, status).
// useChat<OpenAcmeUIMessage>() type-checks the onData callback below and
// any future `sendMessage` consumers that read message metadata.
import type { OpenAcmeUIMessage } from "./lib/types";
import { Sidebar } from "./components/Sidebar";
import { Markdown } from "./components/Markdown";
import { AttachmentChip } from "./components/AttachmentChip";
import { ToolBlock } from "./components/ToolBlock";
import { API_BASE } from "./lib/api";
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import type { ProviderInfo } from "./lib/types";
import {
  ALLOWED_UPLOAD_MIMES,
  UPLOAD_LIMITS,
} from "./lib/types";
import { cn } from "@/app/lib/utils";

interface Agent {
  id: string;
  name: string;
  model: { provider: string; model: string };
  persona: string;
  tools: string[];
}

interface ModelOption {
  provider: string;
  providerName: string;
  id: string;
  label: string;
  hint?: string;
}

interface SessionSummary {
  id: string;
  title: string | null;
  agentId: string;
}

interface PendingAttachment {
  /** Local id used to key chips before the upload finishes. */
  localId: string;
  status: "uploading" | "ready" | "error";
  /** Server-assigned pendingId — present only after upload succeeds. */
  pendingId?: string;
  /** Pending URL `/api/attachments/__pending__/<id>/<file>` — used as
   *  FileUIPart.url when sending. The server's chat handler rewrites it
   *  to the committed `<sessionId>/<attId>/<file>` form. */
  url?: string;
  kind?: "image" | "file";
  mediaType: string;
  size: number;
  filename: string;
  /** Local blob URL for instant image preview while upload is in flight. */
  previewUrl?: string;
  error?: string;
}

type Part = UIMessage["parts"][number];

export default function ChatPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string>("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<{
    providers: ProviderInfo[];
    configured: Record<string, boolean>;
  }>({ providers: [], configured: {} });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  const justSentRef = useRef(false);
  // Refs to keep the transport's `body` callback in sync with current
  // session/agent state without re-creating the transport on every render.
  const activeAgentIdRef = useRef("");
  const activeSessionIdRef = useRef("");
  // Set when the server pins a new session id mid-stream via `data-session`.
  // The history-loading effect would otherwise fetch /messages before the
  // stream's `onFinish` persists anything and wipe the optimistic user bubble.
  const skipNextHistoryFetchRef = useRef(false);
  useEffect(() => {
    activeAgentIdRef.current = activeAgentId;
  }, [activeAgentId]);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // ── Chat state via useChat ────────────────────────────────────────────
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${API_BASE}/api/chat`,
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            agentId: activeAgentIdRef.current,
            sessionId: activeSessionIdRef.current || undefined,
            messages,
          },
        }),
      }),
    []
  );

  // Active server-side status messages, keyed by `data-status.id`. Same id
  // arriving again replaces the entry — the SDK's `data-${name}` parts
  // reconciliation pattern (see CLAUDE.md "Custom data parts").
  const [statusBoard, setStatusBoard] = useState<
    Record<
      string,
      {
        kind: "info" | "warn" | "error" | "compressing" | "compressed";
        message: string;
      }
    >
  >({});

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    error,
  } = useChat<OpenAcmeUIMessage>({
    transport,
    onData: (part) => {
      // Typed by OpenAcmeDataParts: `part.type` narrows `part.data`.
      if (part.type === "data-session") {
        const newId = part.data.sessionId;
        if (newId && newId !== activeSessionIdRef.current) {
          const previousId = activeSessionIdRef.current;
          skipNextHistoryFetchRef.current = true;
          setActiveSessionId(newId);
          setSessions((prev) => {
            const parent = previousId
              ? prev.find((s) => s.id === previousId)
              : undefined;
            const withoutParent = previousId
              ? prev.filter((s) => s.id !== previousId)
              : prev;
            if (withoutParent.some((s) => s.id === newId)) return withoutParent;
            return [
              {
                id: newId,
                title: parent?.title ?? null,
                agentId: activeAgentIdRef.current,
              },
              ...withoutParent,
            ];
          });
        }
        return;
      }
      if (part.type === "data-status") {
        // Reconcile by id — same `id` from the server replaces an existing
        // entry. Empty `message` clears the entry.
        const { id, kind, message } = part.data;
        setStatusBoard((prev) => {
          if (!message) {
            const { [id]: _drop, ...rest } = prev;
            return rest;
          }
          return { ...prev, [id]: { kind, message } };
        });
      }
    },
    onError: (err) => {
      toast.error("Chat failed", { description: err.message });
    },
    onFinish: ({ messages: finalMsgs }) => {
      // The server's onFinish persists the user message with rewritten
      // attachment URLs (pending → committed). The optimistic local
      // user message still carries the dead `__pending__` URLs, so
      // refetch to replace it with the canonical persisted shape.
      // Cheap and only fires for turns that actually had attachments;
      // text-only turns don't need it (URLs are stable).
      const sid = activeSessionIdRef.current;
      if (!sid) return;
      const lastUser = [...finalMsgs].reverse().find((m) => m.role === "user");
      const hasAttachment = lastUser?.parts.some(
        (p: { type?: string; url?: string }) =>
          p.type === "file" && (p.url ?? "").includes("/__pending__/")
      );
      if (!hasAttachment) return;
      fetch(`${API_BASE}/api/sessions/${sid}/messages`)
        .then((r) => r.json())
        .then((data: OpenAcmeUIMessage[]) => setMessages(data))
        .catch(() => {});
    },
  });

  const isStreaming = status === "submitted" || status === "streaming";

  // Abort any in-flight stream when the page unmounts.
  useEffect(() => {
    return () => {
      if (status === "streaming") stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAgentsAndSessions = useCallback(
    async (signal?: AbortSignal): Promise<{ agents: Agent[]; sessions: SessionSummary[] } | null> => {
      try {
        const res = await fetch(`${API_BASE}/api/agents`, { signal });
        if (!res.ok) throw new Error("agents fetch failed");
        const agentList: Agent[] = await res.json();
        const sessionResults = await Promise.all(
          agentList.map(async (agent) => {
            try {
              const r = await fetch(`${API_BASE}/api/agents/${agent.id}/sessions`, { signal });
              if (!r.ok) return [];
              const list = (await r.json()) as { id: string; title: string | null }[];
              return list.map((s) => ({ ...s, agentId: agent.id }));
            } catch (e) {
              if ((e as Error).name === "AbortError") throw e;
              return [];
            }
          })
        );
        return { agents: agentList, sessions: sessionResults.flat() };
      } catch (e) {
        if ((e as Error).name === "AbortError") return null;
        throw e;
      }
    },
    []
  );

  useEffect(() => {
    const ctrl = new AbortController();
    loadAgentsAndSessions(ctrl.signal)
      .then((result) => {
        if (!result) return;
        setAgents(result.agents);
        setSessions(result.sessions);
        setActiveAgentId((current) => current || result.agents[0]?.id || "");
      })
      .catch(() =>
        toast.error("Cannot connect to server", {
          description: "Run `openacme start` first.",
        })
      );
    return () => ctrl.abort();
  }, [loadAgentsAndSessions]);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      fetch(`${API_BASE}/api/models`, { signal: ctrl.signal }).then((r) =>
        r.ok ? (r.json() as Promise<ProviderInfo[]>) : Promise.reject(new Error(r.statusText))
      ),
      fetch(`${API_BASE}/api/keys`, { signal: ctrl.signal })
        .then((r): Promise<{ configured: Record<string, boolean> }> | { configured: Record<string, boolean> } =>
          r.ok ? r.json() : { configured: {} }
        )
        .catch(() => ({ configured: {} as Record<string, boolean> })),
    ])
      .then(([providers, keys]) => {
        setModelCatalog({ providers, configured: keys.configured });
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
      });
    return () => ctrl.abort();
  }, []);

  // Load history when session changes.
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    if (skipNextHistoryFetchRef.current) {
      // Server-pinned id arrived mid-stream; useChat already holds the
      // optimistic user msg + the streaming assistant. Fetching now races
      // with `onFinish`'s persist and would clobber the live state.
      skipNextHistoryFetchRef.current = false;
      return;
    }
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/sessions/${activeSessionId}/messages`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data: OpenAcmeUIMessage[]) => {
        setMessages(data);
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        toast.error("Failed to load messages");
      });
    return () => ctrl.abort();
  }, [activeSessionId, setMessages]);

  useEffect(() => {
    if (!atBottomRef.current && !justSentRef.current) return;
    const behavior: ScrollBehavior = justSentRef.current ? "smooth" : "auto";
    messagesEndRef.current?.scrollIntoView({ behavior });
    justSentRef.current = false;
  }, [messages]);

  const handleScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // Provider gate from the model catalog.
  const activeModalities = (() => {
    if (!activeAgent) return undefined;
    const provider = modelCatalog.providers.find(
      (p) => p.id === activeAgent.model.provider
    );
    if (!provider) return undefined;
    return provider.models.find((m) => m.id === activeAgent.model.model)
      ?.inputModalities;
  })();
  const acceptsAttachments =
    !activeModalities ||
    activeModalities.includes("image") ||
    activeModalities.includes("pdf") ||
    activeModalities.includes("file");

  // ── Attachments ───────────────────────────────────────────────────────
  const removePending = useCallback((localId: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  }, []);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const totalNow = pendingAttachments.reduce((acc, p) => acc + p.size, 0);
      let totalBytes = totalNow;
      const accepted: File[] = [];
      for (const f of files) {
        if (
          pendingAttachments.length + accepted.length >=
          UPLOAD_LIMITS.perRequestFiles
        ) {
          toast.error(
            `Max ${UPLOAD_LIMITS.perRequestFiles} attachments per turn`
          );
          break;
        }
        if (f.size > UPLOAD_LIMITS.perFileBytes) {
          toast.error(`${f.name}: too large (max 5 MB)`);
          continue;
        }
        totalBytes += f.size;
        if (totalBytes > UPLOAD_LIMITS.perRequestBytes) {
          toast.error("Upload would exceed 25 MB total");
          break;
        }
        if (
          !ALLOWED_UPLOAD_MIMES.includes(
            f.type as (typeof ALLOWED_UPLOAD_MIMES)[number]
          )
        ) {
          toast.error(`${f.name}: unsupported type (${f.type || "unknown"})`);
          continue;
        }
        accepted.push(f);
      }
      if (accepted.length === 0) return;

      const records: PendingAttachment[] = accepted.map((f) => ({
        localId: crypto.randomUUID(),
        status: "uploading",
        mediaType: f.type,
        size: f.size,
        filename: f.name,
        previewUrl: f.type.startsWith("image/")
          ? URL.createObjectURL(f)
          : undefined,
      }));
      setPendingAttachments((prev) => [...prev, ...records]);

      const form = new FormData();
      for (let i = 0; i < accepted.length; i++) {
        form.append(`f${i}`, accepted[i]!, accepted[i]!.name);
      }
      try {
        const res = await fetch(`${API_BASE}/api/uploads`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error || res.statusText);
        }
        const data = (await res.json()) as {
          attachments: Array<{
            pendingId: string;
            kind: "image" | "file";
            mediaType: string;
            size: number;
            filename: string;
            url: string;
          }>;
        };
        setPendingAttachments((prev) =>
          prev.map((p) => {
            const matchIdx = records.findIndex(
              (r) => r.localId === p.localId
            );
            if (matchIdx === -1) return p;
            const srv = data.attachments[matchIdx];
            if (!srv)
              return { ...p, status: "error", error: "no server id" };
            return {
              ...p,
              status: "ready",
              pendingId: srv.pendingId,
              url: srv.url,
              kind: srv.kind,
              mediaType: srv.mediaType,
            };
          })
        );
      } catch (err) {
        setPendingAttachments((prev) =>
          prev.map((p) =>
            records.some((r) => r.localId === p.localId)
              ? {
                  ...p,
                  status: "error",
                  error:
                    err instanceof Error ? err.message : String(err),
                }
              : p
          )
        );
        toast.error("Upload failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [pendingAttachments]
  );

  // Drag-and-drop on the textarea container.
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      if (!acceptsAttachments) return;
      e.preventDefault();
      setIsDragging(true);
    },
    [acceptsAttachments]
  );
  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setIsDragging(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      setIsDragging(false);
      if (!acceptsAttachments) {
        toast.error("Active model accepts text only");
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      void uploadFiles(files);
    },
    [uploadFiles, acceptsAttachments]
  );

  const send = useCallback(() => {
    if (!input.trim() && pendingAttachments.length === 0) return;
    if (isStreaming || !activeAgentId) return;
    if (pendingAttachments.some((p) => p.status === "uploading")) {
      toast.error("Wait for uploads to finish");
      return;
    }
    const ready = pendingAttachments.filter(
      (p) => p.status === "ready" && p.url
    );
    const text = input.trim();
    atBottomRef.current = true;
    justSentRef.current = true;
    setInput("");
    // Free preview blobs — the chat now renders via /api/attachments URLs.
    for (const p of pendingAttachments) {
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    }
    setPendingAttachments([]);

    void sendMessage({
      role: "user",
      parts: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...ready.map((p) => ({
          type: "file" as const,
          url: p.url!,
          mediaType: p.mediaType,
          filename: p.filename,
        })),
      ],
    });
  }, [input, isStreaming, activeAgentId, pendingAttachments, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const newChat = () => {
    setMessages([]);
    setActiveSessionId("");
  };

  const deleteSession = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this chat? This cannot be undone.")) return;
      try {
        const res = await fetch(`${API_BASE}/api/sessions/${id}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(await res.text());
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (activeSessionId === id) {
          setActiveSessionId("");
          setMessages([]);
        }
      } catch (err) {
        toast.error("Failed to delete chat", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeSessionId, setMessages]
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar>
        <div className="border-t border-paper-rule pt-3">
          <div className="px-4 pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Agents
          </div>
          {agents.map((agent) => {
            const isActive = agent.id === activeAgentId;
            return (
              <button
                key={agent.id}
                onClick={() => {
                  setActiveAgentId(agent.id);
                  newChat();
                }}
                className={cn(
                  "group relative flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 w-[2px] bg-plot-red transition-opacity",
                    isActive ? "opacity-100" : "opacity-0"
                  )}
                  aria-hidden
                />
                <Bot className="size-3.5 shrink-0" />
                <span className="truncate">{agent.name}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 border-t border-paper-rule pt-3">
          <div className="flex items-center justify-between px-4 pb-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Sessions
            </span>
            <button
              onClick={newChat}
              title="New session"
              aria-label="New session"
              className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft hover:text-plot-red focus:text-plot-red focus:outline-none"
            >
              + New
            </button>
          </div>
          {sessions.slice(0, 30).map((s) => {
            const isActive = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                className={cn(
                  "group relative flex w-full items-center transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 w-[2px] bg-plot-red transition-opacity",
                    isActive ? "opacity-100" : "opacity-0"
                  )}
                  aria-hidden
                />
                <button
                  onClick={() => {
                    if (s.agentId && s.agentId !== activeAgentId) {
                      setActiveAgentId(s.agentId);
                    }
                    setActiveSessionId(s.id);
                  }}
                  className="flex flex-1 min-w-0 items-center gap-3 px-4 py-1.5 text-left text-sm"
                >
                  <MessageSquare className="size-3.5 shrink-0" />
                  <span className="truncate">{s.title || "Untitled session"}</span>
                </button>
                <button
                  onClick={() => deleteSession(s.id)}
                  title="Delete session"
                  aria-label="Delete session"
                  className="mr-2 p-1 opacity-0 transition-opacity hover:text-destructive focus:opacity-100 focus:outline-none focus-visible:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            );
          })}
          {sessions.length === 0 && (
            <div className="px-4 pb-3 font-mono text-[11px] text-ink-faint">
              No sessions yet.
            </div>
          )}
        </div>
      </Sidebar>

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-paper-rule px-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "status-dot",
                  isStreaming ? "bg-plot-red pulse-live" : "bg-ink"
                )}
                aria-hidden
              />
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
                {isStreaming ? "Streaming" : activeAgent ? "Ready" : "No agent"}
              </span>
            </div>
            <span className="h-3 w-px bg-paper-rule" aria-hidden />
            <span className="text-sm font-medium text-ink">
              {activeAgent?.name ?? "—"}
            </span>
            {activeSessionId && (
              <span className="font-mono text-[11px] text-ink-faint tabular-nums">
                · {activeSessionId.slice(0, 8)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {activeAgent && (
              <ModelQuickSwitch
                agent={activeAgent}
                catalog={modelCatalog}
                onChange={async (next) => {
                  const prev = activeAgent;
                  setAgents((list) =>
                    list.map((a) =>
                      a.id === prev.id
                        ? { ...a, model: { ...a.model, provider: next.provider, model: next.id } }
                        : a
                    )
                  );
                  try {
                    const res = await fetch(`${API_BASE}/api/agents/${prev.id}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: { ...prev.model, provider: next.provider, model: next.id },
                      }),
                    });
                    if (!res.ok) throw new Error(await res.text());
                    const fresh = await res.json() as { model: { provider: string; model: string } };
                    setAgents((list) =>
                      list.map((a) =>
                        a.id === prev.id
                          ? { ...a, model: { ...a.model, provider: fresh.model.provider, model: fresh.model.model } }
                          : a
                      )
                    );
                    toast.success(`Switched to ${next.label}`);
                  } catch (err) {
                    setAgents((list) => list.map((a) => (a.id === prev.id ? prev : a)));
                    toast.error("Failed to switch model", {
                      description: err instanceof Error ? err.message : String(err),
                    });
                  }
                }}
              />
            )}
          </div>
        </header>

        {messages.length === 0 ? (
          <div className="flex flex-1 items-start justify-center overflow-y-auto px-6 py-16">
            <div className="w-full max-w-2xl">
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                Session · Empty
              </div>
              <h2 className="mt-2 text-2xl font-semibold leading-tight tracking-tight text-ink">
                {activeAgent ? activeAgent.name : "No agent selected"}
              </h2>
              <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
                {activeAgent
                  ? "Send a message to begin a session. The agent has access to its configured tools, skills, and memory. Conversation, tool calls, and results all persist to this session and remain editable."
                  : "Pick an agent in the sidebar to start a session. Each agent owns its own model, tools, skills, and memory."}
              </p>
              {activeAgent && (
                <div className="mt-8 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-paper-rule pt-4 font-mono text-[12px] tabular-nums">
                  <span className="text-ink-faint uppercase tracking-[0.08em] text-[10px]">Model</span>
                  <span className="text-ink-soft">
                    {activeAgent.model.provider}/{activeAgent.model.model}
                  </span>
                  <span className="text-ink-faint uppercase tracking-[0.08em] text-[10px]">Tools</span>
                  <span className="text-ink-soft">
                    {activeAgent.tools.length} available
                  </span>
                  <span className="text-ink-faint uppercase tracking-[0.08em] text-[10px]">Persona</span>
                  <span className="text-ink-soft truncate">
                    {activeAgent.persona || "—"}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto"
          >
            <div className="mx-auto max-w-3xl px-6 py-6">
              {messages.map((msg, i) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  agent={activeAgent}
                  isStreaming={
                    isStreaming &&
                    msg.role === "assistant" &&
                    i === messages.length - 1
                  }
                />
              ))}
              {error && (
                <div className="mt-4 border-l-2 border-destructive bg-paper-sunk px-3 py-2 font-mono text-[12px] text-destructive">
                  <span className="uppercase tracking-[0.08em] text-[10px] mr-2">Error</span>
                  {error.message}
                </div>
              )}
              {Object.entries(statusBoard).map(([id, s]) => (
                <div
                  key={id}
                  className={cn(
                    "mt-3 flex items-center gap-3 px-3 py-1.5 font-mono text-[12px]",
                    s.kind === "error" && "bg-paper-sunk text-destructive",
                    s.kind === "warn" && "bg-paper-sunk text-warn-ochre",
                    (s.kind === "info" ||
                      s.kind === "compressing" ||
                      s.kind === "compressed") &&
                      "bg-paper-sunk text-ink-soft"
                  )}
                >
                  <span className="status-dot bg-current" aria-hidden />
                  <span className="uppercase tracking-[0.08em] text-[10px]">
                    {s.kind}
                  </span>
                  <span>{s.message}</span>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        <div className="shrink-0 border-t border-paper-rule bg-paper">
          <div className="mx-auto max-w-3xl px-6 py-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Compose
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                <kbd className="border border-paper-rule px-1 py-px text-ink-soft">Enter</kbd>{" "}
                send ·{" "}
                <kbd className="border border-paper-rule px-1 py-px text-ink-soft">⇧ Enter</kbd>{" "}
                newline
              </span>
            </div>
            <div
              className={cn(
                "border border-paper-rule bg-paper transition-colors focus-within:border-plot-red",
                isDragging && "border-plot-red bg-paper-sunk"
              )}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 border-b border-paper-rule bg-paper-sunk px-3 py-2">
                  {pendingAttachments.map((p) => (
                    <AttachmentChip
                      key={p.localId}
                      kind={
                        p.kind ?? (p.mediaType.startsWith("image/") ? "image" : "file")
                      }
                      mediaType={p.mediaType}
                      size={p.size}
                      name={p.filename}
                      status={p.status}
                      error={p.error}
                      removable
                      onRemove={() => removePending(p.localId)}
                    />
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2 px-2 py-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ALLOWED_UPLOAD_MIMES.join(",")}
                  className="hidden"
                  onChange={(e) => {
                    const files = e.target.files ? Array.from(e.target.files) : [];
                    void uploadFiles(files);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming || !activeAgentId || !acceptsAttachments}
                  className="shrink-0"
                  aria-label="Attach files"
                  title={
                    acceptsAttachments
                      ? "Attach files (images, PDFs)"
                      : "Active model accepts text only — switch with the model picker"
                  }
                >
                  <Paperclip className="size-4" />
                </Button>
                <Textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    activeAgent ? `Message ${activeAgent.name}` : "Select an agent"
                  }
                  disabled={isStreaming || !activeAgentId}
                  rows={1}
                  className="min-h-[44px] max-h-48 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:outline-none font-sans text-sm"
                />
                {isStreaming ? (
                  <Button
                    size="icon"
                    variant="destructive"
                    onClick={() => stop()}
                    className="shrink-0"
                    aria-label="Stop generating"
                  >
                    <Square className="size-4 fill-current" />
                    <span className="sr-only">Stop</span>
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    onClick={send}
                    disabled={
                      (!input.trim() && pendingAttachments.length === 0) ||
                      !activeAgentId ||
                      pendingAttachments.some((p) => p.status === "uploading")
                    }
                    className="shrink-0"
                    aria-label="Send message"
                  >
                    <ArrowUp className="size-4" />
                    <span className="sr-only">Send</span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function isToolPart(p: Part): boolean {
  return (
    typeof (p as { type?: unknown }).type === "string" &&
    (p as { type: string }).type.startsWith("tool-")
  );
}

function MessageHeader({
  role,
  model,
  streaming,
}: {
  role: "user" | "assistant";
  model?: string;
  streaming?: boolean;
}) {
  return (
    <div className="mb-3 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
      <span
        className={cn(
          "status-dot",
          role === "assistant" && streaming
            ? "bg-plot-red pulse-live"
            : role === "assistant"
              ? "bg-ink"
              : "bg-ink-faint"
        )}
        aria-hidden
      />
      <span className={role === "assistant" ? "text-ink" : "text-ink-soft"}>
        {role}
      </span>
      {model && role === "assistant" && (
        <>
          <span className="text-ink-faint">·</span>
          <span className="normal-case tracking-normal text-ink-soft">
            {model}
          </span>
        </>
      )}
      {streaming && (
        <>
          <span className="text-ink-faint">·</span>
          <span className="text-plot-red">streaming</span>
        </>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  agent,
  isStreaming,
}: {
  message: UIMessage;
  agent?: Agent;
  isStreaming: boolean;
}) {
  if (message.role === "system") return null;

  if (message.role === "user") {
    const text = message.parts
      .filter(
        (p): p is Extract<Part, { type: "text" }> =>
          (p as { type?: unknown }).type === "text"
      )
      .map((p) => (p as { text: string }).text)
      .join("\n");
    const files = message.parts.filter(
      (p): p is Extract<Part, { type: "file" }> =>
        (p as { type?: unknown }).type === "file"
    );
    const images = files.filter(
      (f) => (f as { mediaType: string }).mediaType.startsWith("image/")
    );
    const others = files.filter(
      (f) => !(f as { mediaType: string }).mediaType.startsWith("image/")
    );
    return (
      <section className="border-t border-paper-rule py-5 first:border-t-0 first:pt-0">
        <MessageHeader role="user" />
        {text && (
          <div className="text-sm leading-relaxed text-ink whitespace-pre-wrap break-words">
            {text}
          </div>
        )}
        {images.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {images.map((f, i) => {
              const part = f as unknown as {
                url: string;
                filename?: string;
              };
              return (
                <a
                  key={i}
                  href={`${API_BASE}${part.url}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden border border-paper-rule bg-paper-sunk transition-colors hover:border-plot-red"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`${API_BASE}${part.url}`}
                    alt={part.filename ?? "attachment"}
                    className="max-h-64 max-w-sm object-contain"
                  />
                </a>
              );
            })}
          </div>
        )}
        {others.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {others.map((f, i) => {
              const part = f as unknown as {
                url: string;
                mediaType: string;
                filename?: string;
              };
              return (
                <AttachmentChip
                  key={i}
                  kind="file"
                  mediaType={part.mediaType}
                  size={0}
                  name={part.filename ?? "file"}
                  href={`${API_BASE}${part.url}`}
                />
              );
            })}
          </div>
        )}
      </section>
    );
  }

  // assistant — render parts in order
  const parts = message.parts;
  const modelLabel = agent ? agent.model.model : undefined;
  const lastTextIdx = (() => {
    for (let i = parts.length - 1; i >= 0; i--) {
      if ((parts[i] as { type?: unknown }).type === "text") return i;
    }
    return -1;
  })();

  return (
    <section className="border-t border-paper-rule py-5 first:border-t-0 first:pt-0">
      <MessageHeader role="assistant" model={modelLabel} streaming={isStreaming} />
      {parts.length === 0 && isStreaming && (
        <div className="flex items-center gap-1.5 text-ink-faint">
          <span className="status-dot bg-current pulse-live" aria-hidden />
          <span className="font-mono text-[11px] uppercase tracking-[0.08em]">
            Thinking
          </span>
        </div>
      )}
      <div className="space-y-3">
        {parts.map((part, i) => {
          if (isToolPart(part)) {
            const tp = part as unknown as {
              type: string;
              toolCallId: string;
              state: string;
              input?: unknown;
              output?: unknown;
              errorText?: string;
            };
            return <ToolBlock key={i} part={tp} isStreaming={isStreaming} />;
          }
          if ((part as { type?: unknown }).type === "text") {
            const text = (part as { text: string }).text;
            if (!text) return null;
            return (
              <div key={i} className="text-sm leading-relaxed text-ink break-words">
                <Markdown>{text}</Markdown>
                {isStreaming && i === lastTextIdx && (
                  <span className="cursor-stream" aria-hidden />
                )}
              </div>
            );
          }
          // reasoning, file, source, data-* — silently ignore in v1.
          return null;
        })}
      </div>
    </section>
  );
}

function ModelQuickSwitch({
  agent,
  catalog,
  onChange,
}: {
  agent: Agent;
  catalog: { providers: ProviderInfo[]; configured: Record<string, boolean> };
  onChange: (next: ModelOption) => void;
}) {
  const value = `${agent.model.provider}/${agent.model.model}`;
  const options: ModelOption[] = [];
  for (const p of catalog.providers) {
    if (!catalog.configured[p.id] && p.id !== agent.model.provider) continue;
    for (const m of p.models ?? []) {
      options.push({
        provider: p.id,
        providerName: p.name,
        id: m.id,
        label: m.label,
        hint: m.hint,
      });
    }
  }
  const grouped = options.reduce<Record<string, ModelOption[]>>((acc, opt) => {
    (acc[opt.providerName] ??= []).push(opt);
    return acc;
  }, {});
  const isKnown = options.some(
    (o) => o.provider === agent.model.provider && o.id === agent.model.model
  );

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const opt = options.find((o) => `${o.provider}/${o.id}` === next);
        if (opt) onChange(opt);
      }}
    >
      <SelectTrigger
        size="sm"
        className="h-7 w-auto gap-1.5 border-dashed bg-muted/40 px-2 font-mono text-[11px]"
        aria-label="Switch model"
      >
        <SelectValue placeholder={value} />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {!isKnown && (
          <SelectGroup>
            <SelectLabel>Current (custom)</SelectLabel>
            <SelectItem value={value}>
              <span className="font-mono">{value}</span>
            </SelectItem>
          </SelectGroup>
        )}
        {Object.entries(grouped).map(([providerName, opts]) => (
          <SelectGroup key={providerName}>
            <SelectLabel>{providerName}</SelectLabel>
            {opts.map((o) => (
              <SelectItem
                key={`${o.provider}/${o.id}`}
                value={`${o.provider}/${o.id}`}
              >
                <div className="flex flex-col items-start">
                  <span>{o.label}</span>
                  {o.hint && (
                    <span className="text-[10px] text-muted-foreground">
                      {o.hint}
                    </span>
                  )}
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
