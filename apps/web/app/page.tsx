"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowUp, Bot, User, Wrench, Sparkles, MessageSquare, Trash2, Square } from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "./components/Sidebar";
import { Markdown } from "./components/Markdown";
import { API_BASE } from "./lib/api";
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { Separator } from "@/app/components/ui/separator";
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

type MessageRole = "user" | "assistant" | "tool" | "system";

type AssistantPart =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: string;
      status: "pending" | "done" | "error";
    };

interface ChatMessage {
  id: string;
  role: MessageRole;
  // For user messages this is the user input. For assistant messages
  // ordered streaming/restored content lives in `parts`; `content` is unused.
  content: string;
  parts?: AssistantPart[];
}

interface SessionSummary {
  id: string;
  title: string | null;
  agentId: string;
}

export default function ChatPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string>("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<{
    providers: ProviderInfo[];
    configured: Record<string, boolean>;
  }>({ providers: [], configured: {} });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  const justSentRef = useRef(false);
  const streamCtrlRef = useRef<AbortController | null>(null);
  // When sendMessage finishes a turn into a brand-new session, it sets
  // activeSessionId — but our in-memory messages already reflect the turn.
  // This ref tells the messages-loading effect to skip its refetch on that
  // single transition so we don't clobber the streamed state with the
  // server's (possibly not-yet-persisted) view.
  const skipNextHistoryLoadRef = useRef(false);

  // Abort any in-flight stream when the page unmounts (route change, reload).
  useEffect(() => {
    return () => streamCtrlRef.current?.abort();
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
        // Soft fail: header just shows the current model as plain text.
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    if (skipNextHistoryLoadRef.current) {
      skipNextHistoryLoadRef.current = false;
      return;
    }
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/sessions/${activeSessionId}/messages`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then(
        (
          data: {
            id: string;
            role: string;
            content: string | null;
            toolCalls?: string | null;
            toolCallId?: string | null;
            toolName?: string | null;
          }[]
        ) => {
          setMessages(rowsToChatMessages(data));
        }
      )
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        toast.error("Failed to load messages");
      });
    return () => ctrl.abort();
  }, [activeSessionId]);

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

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isStreaming || !activeAgentId) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim(),
    };

    atBottomRef.current = true;
    justSentRef.current = true;
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsStreaming(true);

    const assistantId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      parts: [],
    };
    setMessages((prev) => [...prev, assistantMessage]);

    const updateAsstParts = (
      mutate: (parts: AssistantPart[]) => AssistantPart[]
    ) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, parts: mutate(m.parts ?? []) } : m
        )
      );
    };

    let newSessionId = "";
    let streamErrored = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const ctrl = new AbortController();
    streamCtrlRef.current = ctrl;

    const handleSSELine = (line: string) => {
      if (!line.startsWith("data:")) return;
      let data: { type: string; [k: string]: unknown };
      try {
        data = JSON.parse(line.slice(5).trim());
      } catch {
        return;
      }
      dispatchSSE(data);
    };

    const dispatchSSE = (data: { type: string; [k: string]: unknown }) => {
      switch (data.type) {
        case "session":
          newSessionId = (data.sessionId as string) || newSessionId;
          break;
        case "text-delta": {
          const delta = data.text as string;
          updateAsstParts((parts) => {
            const last = parts[parts.length - 1];
            if (last && last.kind === "text") {
              return [
                ...parts.slice(0, -1),
                { kind: "text", text: last.text + delta },
              ];
            }
            return [...parts, { kind: "text", text: delta }];
          });
          break;
        }
        case "tool-call":
          updateAsstParts((parts) => [
            ...parts,
            {
              kind: "tool",
              toolCallId: data.toolCallId as string,
              toolName: data.toolName as string,
              args: data.args as Record<string, unknown>,
              status: "pending",
            },
          ]);
          break;
        case "tool-result":
          updateAsstParts((parts) =>
            parts.map((p) =>
              p.kind === "tool" && p.toolCallId === data.toolCallId
                ? { ...p, result: data.result as string, status: "done" }
                : p
            )
          );
          break;
        case "error":
          streamErrored = true;
          toast.error("Stream error", { description: data.error as string });
          break;
        case "stopped":
          // Server-confirmed user cancel. Partial parts already in the
          // assistant message stay visible; the finally block clears
          // isStreaming and the send button reappears.
          break;
        case "done":
          break;
      }
    };

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: activeAgentId,
          sessionId: activeSessionId || undefined,
          message: userMessage.content,
        }),
        signal: ctrl.signal,
      });

      if (!response.ok) {
        let serverMessage = response.statusText;
        try {
          const body = (await response.json()) as { error?: string };
          if (body?.error) serverMessage = body.error;
        } catch {
          // body wasn't JSON — keep statusText
        }
        throw new Error(serverMessage);
      }

      reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) handleSSELine(line);
      }

      // Flush any final line that didn't end with a newline.
      const tail = buffer + decoder.decode();
      if (tail) handleSSELine(tail);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // User navigated away or component unmounted; stay silent.
        streamErrored = true;
      } else {
        streamErrored = true;
        toast.error("Failed to send", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      reader?.cancel().catch(() => {});
      if (streamCtrlRef.current === ctrl) streamCtrlRef.current = null;
      setIsStreaming(false);
      inputRef.current?.focus();

      if (streamErrored) {
        setMessages((prev) =>
          prev.filter(
            (m) => m.id !== assistantId || (m.parts?.length ?? 0) > 0
          )
        );
      } else if (newSessionId && newSessionId !== activeSessionId) {
        // Two cases land here:
        //  - brand-new session (activeSessionId was empty before this turn);
        //  - mid-stream compression swap (server emitted `session` with the
        //    new child id; the parent is now hidden by listActive).
        // In both cases the in-memory messages are authoritative for this
        // render — tell the history effect to skip its refetch.
        skipNextHistoryLoadRef.current = true;
        const previousId = activeSessionId;
        setActiveSessionId(newSessionId);
        setSessions((prev) => {
          // Drop the parent (now hidden by listActive) and ensure the child
          // is at the top with the parent's title preserved if available.
          const parent = previousId
            ? prev.find((s) => s.id === previousId)
            : undefined;
          const withoutParent = previousId
            ? prev.filter((s) => s.id !== previousId)
            : prev;
          if (withoutParent.some((s) => s.id === newSessionId)) return withoutParent;
          return [
            { id: newSessionId, title: parent?.title ?? null, agentId: activeAgentId },
            ...withoutParent,
          ];
        });
      }
    }
  }, [input, isStreaming, activeAgentId, activeSessionId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
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
        const res = await fetch(`${API_BASE}/api/sessions/${id}`, { method: "DELETE" });
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
    [activeSessionId]
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar>
        <div className="px-3 py-2">
          <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Active agent
          </div>
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => {
                setActiveAgentId(agent.id);
                newChat();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                agent.id === activeAgentId
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              <Bot className="size-3.5" />
              <span className="truncate">{agent.name}</span>
            </button>
          ))}
        </div>

        <Separator className="my-1 mx-3 w-auto" />

        <div className="px-3 py-2">
          <div className="flex items-center justify-between mb-1 px-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              History
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={newChat}
              title="New chat"
              aria-label="New chat"
            >
              <Sparkles className="size-3" />
            </Button>
          </div>
          {sessions.slice(0, 30).map((s) => (
            <div
              key={s.id}
              className={cn(
                "group flex w-full items-center rounded-md transition-colors",
                s.id === activeSessionId
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              <button
                onClick={() => {
                  if (s.agentId && s.agentId !== activeAgentId) {
                    setActiveAgentId(s.agentId);
                  }
                  setActiveSessionId(s.id);
                }}
                className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 text-left text-sm"
              >
                <MessageSquare className="size-3.5 shrink-0" />
                <span className="truncate">{s.title || "New conversation"}</span>
              </button>
              <button
                onClick={() => deleteSession(s.id)}
                title="Delete chat"
                aria-label="Delete chat"
                className="mr-1 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))}
        </div>
      </Sidebar>

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">{activeAgent?.name || "OpenAcme"}</h2>
            {activeAgent && (
              <ModelQuickSwitch
                agent={activeAgent}
                catalog={modelCatalog}
                onChange={async (next) => {
                  const prev = activeAgent;
                  // Optimistic local update so the trigger label flips immediately.
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
                    // Replace optimistic patch with server truth so auth/baseUrl/headers stay intact.
                    setAgents((list) =>
                      list.map((a) =>
                        a.id === prev.id
                          ? { ...a, model: { ...a.model, provider: fresh.model.provider, model: fresh.model.model } }
                          : a
                      )
                    );
                    toast.success(`Switched to ${next.label}`);
                  } catch (err) {
                    // Roll back on failure.
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
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-4">
              <Sparkles className="size-6" />
            </div>
            <h3 className="text-lg font-semibold">Start a conversation</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Chat with your AI agent. It can execute commands, read and write files,
              and use tools to help you.
            </p>
          </div>
        ) : (
          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto"
          >
            <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isStreaming={
                    isStreaming &&
                    msg.role === "assistant" &&
                    msg.id === messages[messages.length - 1]?.id
                  }
                />
              ))}

              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        <div className="shrink-0 border-t bg-background p-4">
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border bg-card p-2 shadow-sm focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/30 transition">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                activeAgent ? `Message ${activeAgent.name}...` : "Select an agent..."
              }
              disabled={isStreaming || !activeAgentId}
              rows={1}
              className="min-h-[44px] max-h-48 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 font-sans"
            />
            {isStreaming ? (
              <Button
                size="icon"
                variant="destructive"
                onClick={() => streamCtrlRef.current?.abort()}
                className="shrink-0"
                aria-label="Stop generating"
              >
                <Square className="size-4 fill-current" />
                <span className="sr-only">Stop</span>
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={sendMessage}
                disabled={!input.trim() || !activeAgentId}
                className="shrink-0"
                aria-label="Send message"
              >
                <ArrowUp className="size-4" />
                <span className="sr-only">Send</span>
              </Button>
            )}
          </div>
          <p className="mx-auto mt-2 max-w-3xl px-1 text-[11px] text-muted-foreground">
            Press{" "}
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
              Enter
            </kbd>{" "}
            to send,{" "}
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
              Shift
            </kbd>
            +
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
              Enter
            </kbd>{" "}
            for newline
          </p>
        </div>
      </main>
    </div>
  );
}

function rowsToChatMessages(
  rows: {
    id: string;
    role: string;
    content: string | null;
    toolCalls?: string | null;
    toolCallId?: string | null;
    toolName?: string | null;
  }[]
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let asstId: string | null = null;
  let asstParts: AssistantPart[] = [];

  const flushAssistant = () => {
    if (!asstId || asstParts.length === 0) {
      asstId = null;
      asstParts = [];
      return;
    }
    out.push({ id: asstId, role: "assistant", content: "", parts: asstParts });
    asstId = null;
    asstParts = [];
  };

  for (const row of rows) {
    if (row.role === "system") continue;

    if (row.role === "user") {
      flushAssistant();
      out.push({
        id: row.id,
        role: "user",
        content: row.content ?? "",
      });
      continue;
    }

    if (row.role === "assistant") {
      if (asstId === null) asstId = row.id;
      if (row.content) {
        asstParts.push({ kind: "text", text: row.content });
      }
      if (row.toolCalls) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.toolCalls);
        } catch {
          parsed = null;
        }
        if (Array.isArray(parsed)) {
          for (const c of parsed) {
            if (!c || typeof c !== "object") continue;
            const e = c as {
              toolCallId?: string;
              id?: string;
              toolName?: string;
              name?: string;
              args?: unknown;
            };
            const toolCallId = e.toolCallId ?? e.id ?? "";
            const toolName = e.toolName ?? e.name ?? "";
            if (!toolCallId || !toolName) continue;
            asstParts.push({
              kind: "tool",
              toolCallId,
              toolName,
              args: (e.args as Record<string, unknown>) ?? {},
              status: "pending",
            });
          }
        }
      }
      continue;
    }

    if (row.role === "tool") {
      if (!row.toolCallId) continue;
      const target = asstParts.find(
        (p): p is Extract<AssistantPart, { kind: "tool" }> =>
          p.kind === "tool" && p.toolCallId === row.toolCallId
      );
      if (!target) continue;
      target.result = row.content ?? "";
      target.status = "done";
    }
  }

  flushAssistant();
  return out;
}

function Avatar({ role }: { role: "user" | "assistant" }) {
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full border",
        role === "assistant"
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground"
      )}
    >
      {role === "assistant" ? <Bot className="size-4" /> : <User className="size-4" />}
    </div>
  );
}

function MessageBubble({
  message,
  isStreaming,
}: {
  message: ChatMessage;
  isStreaming: boolean;
}) {
  if (message.role !== "user" && message.role !== "assistant") return null;

  if (message.role === "user") {
    return (
      <div className="flex gap-3">
        <Avatar role="user" />
        <div className="flex-1 space-y-2 min-w-0">
          <div className="text-xs font-medium text-muted-foreground capitalize">
            user
          </div>
          <div className="text-sm break-words whitespace-pre-wrap">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  const parts = message.parts ?? [];
  const lastTextIdx = (() => {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]?.kind === "text") return i;
    }
    return -1;
  })();

  return (
    <div className="flex gap-3">
      <Avatar role="assistant" />
      <div className="flex-1 space-y-2 min-w-0">
        <div className="text-xs font-medium text-muted-foreground capitalize">
          assistant
        </div>

        {parts.length === 0 && isStreaming && (
          <div className="flex items-center gap-1.5 pt-2 text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:0ms]" />
            <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:160ms]" />
            <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:320ms]" />
          </div>
        )}

        {parts.map((part, i) =>
          part.kind === "tool" ? (
            <div
              key={i}
              className="rounded-lg border border-border bg-muted/60 overflow-hidden"
            >
              <div className="flex items-center gap-2 border-b border-border/80 bg-muted px-3 py-2 text-xs">
                <Wrench className="size-3 text-primary" />
                <span className="font-mono font-medium">{part.toolName}</span>
              </div>
              <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] text-muted-foreground">
                {JSON.stringify(part.args, null, 2)}
              </pre>
              {part.result && (
                <div className="border-t border-border/80 bg-background/40 px-3 py-2 font-mono text-[11px]">
                  {part.result.length > 600
                    ? part.result.slice(0, 600) + "…"
                    : part.result}
                </div>
              )}
            </div>
          ) : part.text ? (
            <div key={i} className="text-sm break-words">
              <Markdown>{part.text}</Markdown>
              {isStreaming && i === lastTextIdx && (
                <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] bg-primary animate-pulse" />
              )}
            </div>
          ) : null
        )}
      </div>
    </div>
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
  // Show a provider's models if it has credentials OR it's the agent's current
  // provider (so a user who explicitly set up an Ollama/Custom agent can still
  // switch between models within that provider).
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
  // If the current agent's model isn't in the curated presets, surface it as
  // a sticky "Current" group so the trigger has something to show.
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
