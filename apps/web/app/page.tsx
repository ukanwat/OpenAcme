"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowUp, Bot, User, Wrench, Sparkles, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "./components/Sidebar";
import { API_BASE } from "./lib/api";
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { Badge } from "@/app/components/ui/badge";
import { Separator } from "@/app/components/ui/separator";
import { cn } from "@/app/lib/utils";

interface Agent {
  id: string;
  name: string;
  model: { provider: string; model: string };
  persona: string;
  tools: string[];
}

type MessageRole = "user" | "assistant" | "tool" | "system";

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
}

interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  toolCallId: string;
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
      .then((data: { id: string; role: string; content: string | null }[]) => {
        const msgs: ChatMessage[] = data
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            id: m.id,
            role: m.role as MessageRole,
            content: m.content ?? "",
          }));
        setMessages(msgs);
      })
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
      toolCalls: [],
    };
    setMessages((prev) => [...prev, assistantMessage]);

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
        case "text-delta":
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + (data.text as string) }
                : m
            )
          );
          break;
        case "tool-call":
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    toolCalls: [
                      ...(m.toolCalls || []),
                      {
                        toolName: data.toolName as string,
                        args: data.args as Record<string, unknown>,
                        toolCallId: data.toolCallId as string,
                      },
                    ],
                  }
                : m
            )
          );
          break;
        case "tool-result":
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    toolCalls: (m.toolCalls || []).map((tc) =>
                      tc.toolCallId === data.toolCallId
                        ? { ...tc, result: data.result as string }
                        : tc
                    ),
                  }
                : m
            )
          );
          break;
        case "error":
          streamErrored = true;
          toast.error("Stream error", { description: data.error as string });
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
            (m) =>
              m.id !== assistantId ||
              m.content.length > 0 ||
              (m.toolCalls && m.toolCalls.length > 0)
          )
        );
      } else if (newSessionId && !activeSessionId) {
        // We just streamed into a brand-new session; the in-memory messages
        // are authoritative for this render. Tell the history effect to
        // skip its refetch so it doesn't overwrite our state.
        skipNextHistoryLoadRef.current = true;
        setActiveSessionId(newSessionId);
        setSessions((prev) =>
          prev.some((s) => s.id === newSessionId)
            ? prev
            : [{ id: newSessionId, title: null, agentId: activeAgentId }, ...prev]
        );
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
            <button
              key={s.id}
              onClick={() => {
                if (s.agentId && s.agentId !== activeAgentId) {
                  setActiveAgentId(s.agentId);
                }
                setActiveSessionId(s.id);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                s.id === activeSessionId
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              <MessageSquare className="size-3.5 shrink-0" />
              <span className="truncate">{s.title || "New conversation"}</span>
            </button>
          ))}
        </div>
      </Sidebar>

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">{activeAgent?.name || "OpenAcme"}</h2>
            {activeAgent && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                {activeAgent.model.provider}/{activeAgent.model.model}
              </Badge>
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

              {isStreaming &&
                messages[messages.length - 1]?.role === "assistant" &&
                !messages[messages.length - 1]?.content &&
                !messages[messages.length - 1]?.toolCalls?.length && (
                  <div className="flex gap-3">
                    <Avatar role="assistant" />
                    <div className="flex items-center gap-1.5 pt-2 text-muted-foreground">
                      <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:0ms]" />
                      <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:160ms]" />
                      <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:320ms]" />
                    </div>
                  </div>
                )}

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
            <Button
              size="icon"
              onClick={sendMessage}
              disabled={isStreaming || !input.trim() || !activeAgentId}
              className="shrink-0"
              aria-label="Send message"
            >
              <ArrowUp className="size-4" />
              <span className="sr-only">Send</span>
            </Button>
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
  return (
    <div className="flex gap-3">
      <Avatar role={message.role} />
      <div className="flex-1 space-y-2 min-w-0">
        <div className="text-xs font-medium text-muted-foreground capitalize">
          {message.role}
        </div>

        {message.toolCalls?.map((tc, i) => (
          <div
            key={i}
            className="rounded-lg border border-border bg-muted/60 overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-border/80 bg-muted px-3 py-2 text-xs">
              <Wrench className="size-3 text-primary" />
              <span className="font-mono font-medium">{tc.toolName}</span>
            </div>
            <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(tc.args, null, 2)}
            </pre>
            {tc.result && (
              <div className="border-t border-border/80 bg-background/40 px-3 py-2 font-mono text-[11px]">
                {tc.result.length > 600
                  ? tc.result.slice(0, 600) + "…"
                  : tc.result}
              </div>
            )}
          </div>
        ))}

        {message.content && (
          <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
            {message.content}
            {isStreaming && (
              <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] bg-primary animate-pulse" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
