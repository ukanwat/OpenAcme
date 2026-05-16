"use client";

import {
  Suspense,
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { ArrowUp, Square, Paperclip } from "lucide-react";
import { toast } from "sonner";
import type { UIMessage } from "ai";
import type { MessageMetadata, OpenAcmeUIMessage } from "./lib/types";
import { Sidebar } from "./components/Sidebar";
import { HomeView } from "./components/HomeView";
import { useLiveSession } from "./lib/useLiveSession";
import { Markdown } from "./components/Markdown";
import { AttachmentChip } from "./components/AttachmentChip";
import { ToolBlock } from "./components/ToolBlock";
import { API_BASE } from "./lib/api";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { ScribedRule } from "@/app/components/ui/scribed-rule";
import { JargonChip } from "@/app/components/ui/jargon-chip";
import { ChatSetupPanel } from "./components/ChatSetupPanel";
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
  role: string;
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.then((v) => v), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

function statusLabel(submitting: boolean, running: boolean, hasAgent: boolean): string {
  if (submitting) return "Submitting";
  if (running) return "Running";
  return hasAgent ? "Ready" : "No agent";
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatPageInner />
    </Suspense>
  );
}

function ChatPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionFromUrl = searchParams.get("session") ?? "";
  const agentFromUrl = searchParams.get("agent") ?? "";

  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string>(agentFromUrl);
  const [activeSessionId, setActiveSessionId] = useState<string>(sessionFromUrl);
  // Session title for the chat header. Fetched on session change; the
  // server also updates this asynchronously after the first turn (via
  // `agent.fireTitle`), so we refresh on `messages.length` transitions
  // 0 → 1 too.
  const [activeSessionTitle, setActiveSessionTitle] = useState<string | null>(
    null
  );
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
  const activeAgentIdRef = useRef("");
  const activeSessionIdRef = useRef("");
  // Client-generated sessions don't exist server-side until the first
  // POST; the history + metadata fetches skip these to avoid 404s and
  // clobbering the optimistic user bubble with an empty array.
  const freshSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeAgentIdRef.current = activeAgentId;
  }, [activeAgentId]);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // State → URL sync. `searchParams` is read at fire time but is NOT
  // a dependency — including it would re-fire on every URL change and
  // race the URL → state sync below, clobbering an in-flight HomeView
  // navigation back to "/".
  useEffect(() => {
    const currentSession = searchParams.get("session") ?? "";
    const currentAgent = searchParams.get("agent") ?? "";
    if (activeSessionId === currentSession && activeAgentId === currentAgent) {
      return;
    }
    if (!activeSessionId) {
      if (currentSession) router.replace("/");
      return;
    }
    const qs = activeAgentId
      ? `session=${encodeURIComponent(activeSessionId)}&agent=${encodeURIComponent(activeAgentId)}`
      : `session=${encodeURIComponent(activeSessionId)}`;
    router.replace(`/?${qs}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, activeAgentId, router]);

  // URL → state sync (browser nav, HomeView row click).
  useEffect(() => {
    if (sessionFromUrl !== activeSessionId) {
      setActiveSessionId(sessionFromUrl);
    }
    if (agentFromUrl && agentFromUrl !== activeAgentId) {
      setActiveAgentId(agentFromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionFromUrl, agentFromUrl]);

  const [messages, setMessages] = useState<OpenAcmeUIMessage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Messages the user sent while a turn was already streaming. They
  // live here (as floating chips above the input) until the next turn
  // fires and the server-side autonomous drain persists each one to
  // chat history. We track by id so the SSE/refetch upsert can clear
  // them as their canonical version lands in `messages`.
  type QueuedMessage = {
    id: string;
    parts: OpenAcmeUIMessage["parts"];
  };
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);

  // `data-status` board: same id replaces; empty message clears.
  const [statusBoard, setStatusBoard] = useState<
    Record<
      string,
      {
        kind: "info" | "warn" | "error" | "compressing" | "compressed";
        message: string;
      }
    >
  >({});

  const liveSession = useLiveSession(
    activeSessionId || null,
    activeSessionId ? setMessages : null,
    {
      onDataPart: (part) => {
        if (part.type === "data-status") {
          const data = part.data as {
            id: string;
            kind: "info" | "warn" | "error" | "compressing" | "compressed";
            message: string;
          };
          setStatusBoard((prev) => {
            if (!data.message) {
              const next = { ...prev };
              delete next[data.id];
              return next;
            }
            return { ...prev, [data.id]: { kind: data.kind, message: data.message } };
          });
        }
      },
      // Tab-to-tab queue sync: another tab queued a message, render
      // the chip here too. Dedup by id so the originating tab's own
      // optimistic add isn't duplicated when its own broadcast comes
      // back.
      onInboxQueued: ({ messageId, parts }) => {
        setQueuedMessages((q) => {
          if (q.some((m) => m.id === messageId)) return q;
          return [...q, { id: messageId, parts: parts as OpenAcmeUIMessage["parts"] }];
        });
      },
      // Another tab cancelled a queued message — drop the chip.
      onInboxCancelled: ({ messageId }) => {
        setQueuedMessages((q) => q.filter((m) => m.id !== messageId));
      },
    }
  );
  const isLiveRunning = liveSession.state === "running";
  const isStreaming = submitting || isLiveRunning;

  // On running → idle, refetch canonical history (DB carries
  // sanitization + server-side recall part the chunk path doesn't) and
  // the session title (set fire-and-forget post-turn).
  const prevLiveRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevLiveRunningRef.current;
    prevLiveRunningRef.current = isLiveRunning;
    if (!activeSessionId || !wasRunning || isLiveRunning) return;
    const sid = activeSessionId;
    fetch(`${API_BASE}/api/sessions/${sid}/messages`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: OpenAcmeUIMessage[] | null) => {
        if (data) setMessages(data);
      })
      .catch(() => {});
    fetch(`${API_BASE}/api/sessions/${sid}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { title?: string | null } | null) => {
        if (data) setActiveSessionTitle(data.title ?? null);
      })
      .catch(() => {});
  }, [isLiveRunning, activeSessionId]);

  // Server-owned turn — survives tab close; explicit cancel only.
  const stop = useCallback(async () => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    try {
      await fetch(`${API_BASE}/api/sessions/${sid}/active-turn`, {
        method: "DELETE",
      });
    } catch {
      /* best-effort */
    }
  }, []);

  const loadAgents = useCallback(
    async (signal?: AbortSignal): Promise<Agent[] | null> => {
      try {
        const res = await fetch(`${API_BASE}/api/agents`, { signal });
        if (!res.ok) throw new Error("agents fetch failed");
        return (await res.json()) as Agent[];
      } catch (e) {
        if ((e as Error).name === "AbortError") return null;
        throw e;
      }
    },
    []
  );

  useEffect(() => {
    const ctrl = new AbortController();
    loadAgents(ctrl.signal)
      .then((list) => {
        if (!list) return;
        setAgents(list);
        setActiveAgentId((current) => current || list[0]?.id || "");
      })
      .catch(() =>
        toast.error("Cannot connect to server", {
          description: "Run `openacme start` first.",
        })
      );
    return () => ctrl.abort();
  }, [loadAgents]);

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

  // Re-fetch just the keys map; called after a save in the setup panel so the
  // `nothingConfigured` gate flips and the panel unmounts.
  const reloadKeys = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/keys`);
      if (!r.ok) return;
      const data = (await r.json()) as { configured: Record<string, boolean> };
      setModelCatalog((prev) => ({ ...prev, configured: data.configured ?? {} }));
    } catch {
      // Silent; the panel toasts on its own save error.
    }
  }, []);

  const nothingConfigured = useMemo(() => {
    // Gate is decorative until both /api/models and /api/keys responded.
    if (modelCatalog.providers.length === 0) return false;
    const entries = Object.entries(modelCatalog.configured);
    if (entries.length === 0) return false;
    return entries.every(([, v]) => !v);
  }, [modelCatalog]);

  // True while we're fetching history for `activeSessionId`. The chat
  // area uses this to suppress its empty-state flash between the
  // synchronous `setMessages([])` and the async fetch resolution —
  // otherwise opening a session briefly renders `ChatAgentReadyState`
  // before the real messages land. Reset on every session change so a
  // genuinely empty session (no messages at all) still shows the
  // empty state after the fetch completes.
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (!activeSessionId) {
      setActiveSessionTitle(null);
      return;
    }
    // Skip the fetch for freshly-created sessions — the row doesn't
    // exist server-side until /api/chat lands, and the running→idle
    // effect refetches title after the first turn anyway.
    if (freshSessionIdRef.current === activeSessionId) return;
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/sessions/${activeSessionId}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { title?: string | null } | null) => {
        if (!data) return;
        setActiveSessionTitle(data.title ?? null);
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
      });
    return () => ctrl.abort();
  }, [activeSessionId]);

  // Load history when session changes.
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      setHistoryLoading(false);
      return;
    }
    if (freshSessionIdRef.current === activeSessionId) {
      // Session was just created locally by `send` — there's nothing
      // persisted yet, and we already appended the optimistic user
      // bubble. Fetching would clobber that with an empty array.
      freshSessionIdRef.current = null;
      setHistoryLoading(false);
      return;
    }
    // Clear synchronously before the new history lands — otherwise the
    // previous session's messages stay visible until the fetch resolves,
    // which makes session switches feel like "old chat is still here".
    setMessages([]);
    setHistoryLoading(true);
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/sessions/${activeSessionId}/messages`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data: OpenAcmeUIMessage[]) => {
        setMessages(data);
        setHistoryLoading(false);
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        setHistoryLoading(false);
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

  const send = useCallback(async () => {
    if (!input.trim() && pendingAttachments.length === 0) return;
    if (!activeAgentId) return;
    // Mid-turn sends are allowed: the server queues them into the
    // agent's inbox without aborting the in-flight turn. The message
    // persists to chat history immediately so the UI renders it
    // in-order; the next turn picks it up.
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
    setError(null);
    for (const p of pendingAttachments) {
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    }
    setPendingAttachments([]);

    // Client-owned sessionId — the server creates the row from
    // whatever we pass, so the SSE subscription connects up-front and
    // can't miss the agent's first chunks.
    let sid = activeSessionIdRef.current;
    const isNewSession = !sid;
    if (!sid) {
      sid = crypto.randomUUID();
      freshSessionIdRef.current = sid;
      activeSessionIdRef.current = sid;
      setActiveSessionId(sid);
    }

    const userMessageId = crypto.randomUUID();
    const userParts: UIMessage["parts"] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...ready.map((p) => ({
        type: "file" as const,
        url: p.url!,
        mediaType: p.mediaType,
        filename: p.filename,
      })),
    ];
    const optimisticUser: OpenAcmeUIMessage = {
      id: userMessageId,
      role: "user",
      parts: userParts as OpenAcmeUIMessage["parts"],
    };

    // Mid-turn send → server returns { queued: true } and persists the
    // message after the running turn ends. Render it as a queued chip
    // above the input rather than landing it in the chat history
    // immediately — the chat history will pick it up via SSE when the
    // autonomous drain persists it.
    const willQueue = isStreaming;
    const historyForServer = [...messages, optimisticUser];
    if (willQueue) {
      setQueuedMessages((q) => [
        ...q,
        {
          id: userMessageId,
          parts: userParts as OpenAcmeUIMessage["parts"],
        },
      ]);
    } else {
      setMessages(historyForServer);
    }

    setSubmitting(true);
    try {
      if (isNewSession) await withTimeout(liveSession.whenConnected(), 2000);

      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: activeAgentIdRef.current,
          sessionId: sid,
          messages: historyForServer,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || res.statusText);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      toast.error("Send failed", { description: e.message });
      // On failure, drop the queued chip so the user can retry. (Chat
      // history changes are already best-effort; the optimistic add
      // happened earlier and is hard to surgically remove without
      // walking ids.)
      if (willQueue) {
        setQueuedMessages((q) => q.filter((m) => m.id !== userMessageId));
      }
    } finally {
      setSubmitting(false);
    }
  }, [input, isStreaming, activeAgentId, pendingAttachments, messages, liveSession]);

  // When the canonical version of a queued message lands in `messages`
  // (server persisted it during the autonomous follow-up turn and
  // SSE/refetch brought it in), drop the chip. We match by id so any
  // optimistic vs persisted timing race resolves cleanly.
  useEffect(() => {
    if (queuedMessages.length === 0) return;
    const messageIds = new Set(messages.map((m) => m.id));
    setQueuedMessages((q) => q.filter((m) => !messageIds.has(m.id)));
  }, [messages, queuedMessages.length]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const cancelQueued = useCallback(
    async (messageId: string) => {
      // Optimistic chip removal — drop locally first so the UI feels
      // instant. If the cancel races the autonomous drain (server
      // returns `cancelled: 0`), the message has already started
      // processing and will appear in chat history. Surface that to
      // the user with a toast rather than silently letting them think
      // it was cancelled.
      setQueuedMessages((all) => all.filter((m) => m.id !== messageId));
      const sid = activeSessionIdRef.current;
      if (!sid) return;
      try {
        const res = await fetch(
          `${API_BASE}/api/sessions/${encodeURIComponent(sid)}/queued/${encodeURIComponent(messageId)}`,
          { method: "DELETE" }
        );
        if (res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            cancelled?: number;
          };
          if (body.cancelled === 0) {
            toast.message("Already processing", {
              description:
                "The agent had already started on this message — it will appear in the chat.",
            });
          }
        }
      } catch {
        // Network failure leaves the inbox row in place; next turn
        // will drain it and the message lands in chat. Surface so
        // the user isn't surprised by an "uncancelled" message.
        toast.error("Cancel failed", {
          description: "Network error — the message may still arrive.",
        });
      }
    },
    []
  );

  // First-run / "no provider configured" takes over the whole viewport.
  // The chat chrome (sidebar, sessions, composer) is non-functional without
  // a credential, so showing it would lie about what's available.
  if (nothingConfigured) {
    return (
      <main className="paper-surface relative min-h-screen overflow-y-auto bg-paper">
        <ChatSetupPanel
          providers={modelCatalog.providers}
          onSetup={async () => {
            // Setup wrote `model` to config.yaml and the server evicted
            // its cached Agents; the bundled platform agent (Acme) now
            // resolves to the freshly-picked provider's default. Refresh
            // BOTH /api/keys (gates the panel itself) AND /api/agents
            // (so the chat header / persona shows the new resolved
            // model without a page reload).
            await Promise.all([reloadKeys(), loadAgents().then((list) => list && setAgents(list))]);
          }}
        />
      </main>
    );
  }

  // Layout: Sidebar (icons) | HomeView (compact when a session is
  // selected, full otherwise) | Chat panel (only when a session is
  // selected, or when the URL explicitly opens a new chat with an
  // agent via `?agent=<id>`). Driven off URL not state so navigating
  // back to `/` always returns to Home regardless of auto-picked
  // activeAgentId.
  const chatOpen = !!activeSessionId || !!agentFromUrl;
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <HomeView compact={chatOpen} />
      {chatOpen && (
      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-paper-rule px-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "status-dot transition-colors",
                  isStreaming ? "bg-plot-red pulse-live" : "bg-ink"
                )}
                aria-hidden
              />
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
                {statusLabel(submitting, isLiveRunning, !!activeAgent)}
              </span>
            </div>
            <span className="h-3 w-px bg-paper-rule" aria-hidden />
            <span className="min-w-0 truncate text-sm font-medium text-ink">
              {activeSessionTitle ||
                (activeSessionId ? "Untitled session" : "New chat")}
            </span>
            {activeAgent && (
              <span className="font-mono text-[11px] text-ink-faint">
                · {activeAgent.name}
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
          historyLoading ? (
            // History is in flight; suppress the empty-state poster so
            // it doesn't flash between `setMessages([])` and the fetch
            // resolution. Plain spacer keeps the layout stable.
            <div className="flex-1" />
          ) : (
            <div className="flex flex-1 items-start justify-center overflow-y-auto px-6 py-16">
              <div
                key={activeAgent?.id ?? (agents.length === 0 ? "_none" : "_pick")}
                className="w-full max-w-2xl section-enter"
              >
                {agents.length === 0 ? (
                  <ChatNoAgentsState />
                ) : activeAgent ? (
                  <ChatAgentReadyState agent={activeAgent} />
                ) : (
                  <ChatSelectAgentState />
                )}
              </div>
            </div>
          )
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
                <div className="mt-4 border border-destructive bg-paper-sunk px-3 py-2 font-mono text-[12px] text-destructive section-enter">
                  <span className="mr-2 text-[10px] uppercase tracking-[0.08em]">Error</span>
                  {error.message}
                </div>
              )}
              {Object.entries(statusBoard).map(([id, s]) => (
                <div
                  key={id}
                  className={cn(
                    "mt-3 flex items-center gap-3 px-3 py-1.5 font-mono text-[12px] section-enter",
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
            {queuedMessages.length > 0 && (
              <div className="mb-2 border border-paper-rule bg-paper-sunk px-3 py-2">
                <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  <span>
                    Queued · {queuedMessages.length}
                  </span>
                  <span>Sent on next turn</span>
                </div>
                <ul className="space-y-1">
                  {queuedMessages.map((q) => {
                    const textPart = q.parts.find(
                      (p) => (p as { type?: string }).type === "text"
                    ) as { type: "text"; text?: string } | undefined;
                    const filePart = q.parts.find(
                      (p) => (p as { type?: string }).type === "file"
                    ) as { type: "file"; filename?: string } | undefined;
                    const summary =
                      (textPart?.text?.trim() ?? "") ||
                      (filePart?.filename ? `[file: ${filePart.filename}]` : "(empty)");
                    return (
                      <li
                        key={q.id}
                        className="flex items-start gap-2 text-sm text-ink-soft"
                      >
                        <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-plot-red pulse-live" />
                        <span className="line-clamp-2 break-words">{summary}</span>
                        <button
                          type="button"
                          className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint hover:text-plot-red"
                          aria-label="Cancel queued message"
                          onClick={() => void cancelQueued(q.id)}
                          title="Cancel — drops the queued message before the next turn picks it up"
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
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
                  disabled={!activeAgentId || !acceptsAttachments}
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
                    activeAgent
                      ? isStreaming
                        ? `Queue next message for ${activeAgent.name}…`
                        : `Message ${activeAgent.name}`
                      : "Select an agent"
                  }
                  disabled={!activeAgentId}
                  rows={1}
                  className="min-h-[44px] max-h-48 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:outline-none font-sans text-sm"
                />
                {/* When the agent is mid-turn we show BOTH Stop and Send.
                    Send queues the message (server writes it to chat + to
                    the inbox; the running turn keeps going, the new
                    message gets picked up on the next turn). Stop aborts
                    the current run if the user wants to redirect instead.
                    When idle, only Send is shown. */}
                {isStreaming && (
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
                )}
                <Button
                  size="icon"
                  onClick={() => void send()}
                  disabled={
                    (!input.trim() && pendingAttachments.length === 0) ||
                    !activeAgentId ||
                    pendingAttachments.some((p) => p.status === "uploading")
                  }
                  className="shrink-0"
                  aria-label={isStreaming ? "Queue message" : "Send message"}
                  title={
                    isStreaming
                      ? "Queue for next turn (current turn keeps going)"
                      : "Send"
                  }
                >
                  <ArrowUp className="size-4" />
                  <span className="sr-only">
                    {isStreaming ? "Queue" : "Send"}
                  </span>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </main>
      )}
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
          "status-dot transition-colors",
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

  // Hide autonomous-event scaffolding messages — they're internal
  // signals from the scheduler / event feed, not human conversation.
  // The agent's response that follows still renders standalone.
  const meta = (message as { metadata?: MessageMetadata }).metadata;
  if (meta?.kind === "autonomous_event") return null;

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
      <section className="section-enter border-t border-paper-rule py-5 first:border-t-0 first:pt-0">
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
    <section className="section-enter border-t border-paper-rule py-5 first:border-t-0 first:pt-0">
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
          // reasoning / file / source / other data-* — ignored in v1.
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


function ChatNoAgentsState() {
  return (
    <>
      <SectionEyebrow meta="0 agents">No agents configured</SectionEyebrow>
      <p className="mt-5 max-w-prose text-[14px] leading-relaxed text-ink-soft">
        An{" "}
        <JargonChip
          term="Agent"
          explanation="A YAML+prose file at ~/.openacme/agents/<id>/AGENT.md. Owns its own model, tools, MCP servers, sessions, memory, and tasks. Loaded into the daemon at startup and on edit."
        >
          <span className="text-ink">agent</span>
        </JargonChip>{" "}
        in OpenAcme is a file at{" "}
        <code className="px-1 py-0.5 font-mono text-[12px] text-ink">
          ~/.openacme/agents/&lt;id&gt;/AGENT.md
        </code>{" "}
        — YAML frontmatter for its model, tools, and MCP servers, plus
        prose for its persona. Each one owns its own sessions, memory,
        and tasks.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button asChild>
          <Link href="/agents">Create your first agent</Link>
        </Button>
        <span className="text-[12px] text-ink-faint">
          or run{" "}
          <code className="px-1 py-0.5 font-mono text-[12px] text-ink">
            openacme setup
          </code>{" "}
          in the CLI
        </span>
      </div>
    </>
  );
}

function ChatSelectAgentState() {
  return (
    <>
      <SectionEyebrow>Select an agent</SectionEyebrow>
      <p className="mt-5 max-w-prose text-[14px] leading-relaxed text-ink-soft">
        Choose an agent from the sidebar to start a session. Each agent
        owns its model, tools, skills, and memory; sessions persist on
        disk under the daemon&apos;s data dir.
      </p>
    </>
  );
}

function ChatAgentReadyState({ agent }: { agent: Agent }) {
  return (
    <>
      <SectionEyebrow
        meta={
          <span>
            <span className="text-ink-faint">model · </span>
            <span className="text-ink">
              {agent.model.provider}/{agent.model.model}
            </span>
          </span>
        }
      >
        {agent.name}
      </SectionEyebrow>
      {agent.persona && (
        <p className="mt-5 max-w-prose text-[14px] leading-relaxed text-ink-soft">
          {agent.persona}
        </p>
      )}
      <div className="mt-8">
        <ScribedRule delay={200} />
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 meta-row">
          <span>
            <span className="text-ink-faint">tools · </span>
            <span className="text-ink">{agent.tools.length}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="status-dot bg-ink" />
            <span className="label-faceplate">Ready</span>
          </span>
        </div>
      </div>
    </>
  );
}
