"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";

// ── Types ──
interface Agent {
  id: string;
  name: string;
  model: { provider: string; model: string };
  persona: string;
  tools: string[];
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  toolCallId: string;
}

// Use same origin when served from the API server, otherwise fallback to localhost
const API_BASE = typeof window !== "undefined" && window.location.port === "3210"
  ? ""
  : (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3210");

// ── Main App ──
export default function ChatPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string>("");
  const [sessions, setSessions] = useState<
    { id: string; title: string | null; agentId: string }[]
  >([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load agents on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/agents`)
      .then((r) => r.json())
      .then((data: Agent[]) => {
        setAgents(data);
        if (data.length > 0 && !activeAgentId) {
          setActiveAgentId(data[0]!.id);
        }
      })
      .catch(() => setError("Cannot connect to server. Run `openacme start` first."));
  }, []);

  // Load all sessions on mount (not filtered by agent)
  useEffect(() => {
    // Load sessions for all agents
    fetch(`${API_BASE}/api/agents`)
      .then((r) => r.json())
      .then(async (agents: Agent[]) => {
        const allSessions: { id: string; title: string | null; agentId: string }[] = [];
        for (const agent of agents) {
          try {
            const res = await fetch(`${API_BASE}/api/agents/${agent.id}/sessions`);
            const agentSessions = await res.json();
            allSessions.push(...agentSessions.map((s: { id: string; title: string | null }) => ({
              ...s,
              agentId: agent.id,
            })));
          } catch {
            // ignore errors for individual agents
          }
        }
        setSessions(allSessions);
      })
      .catch(() => {});
  }, []);

  // Load messages when session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    fetch(`${API_BASE}/api/sessions/${activeSessionId}/messages`)
      .then((r) => r.json())
      .then((data) => {
        // Transform server messages to our format
        const msgs: ChatMessage[] = data.map((m: { id: string; role: string; content: string }) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
        setMessages(msgs);
      })
      .catch(() => setError("Failed to load messages"));
  }, [activeSessionId]);

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // ── Send Message ──
  const sendMessage = useCallback(async () => {
    if (!input.trim() || isStreaming || !activeAgentId) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsStreaming(true);
    setError("");

    // Create a placeholder for the assistant response
    const assistantId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      toolCalls: [],
    };
    setMessages((prev) => [...prev, assistantMessage]);

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: activeAgentId,
          sessionId: activeSessionId || undefined,
          message: userMessage.content,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      if (!reader) throw new Error("No response body");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            try {
              const data = JSON.parse(line.slice(5).trim());

              switch (data.type) {
                case "text-delta":
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: m.content + data.text }
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
                                toolName: data.toolName,
                                args: data.args,
                                toolCallId: data.toolCallId,
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
                                ? { ...tc, result: data.result }
                                : tc
                            ),
                          }
                        : m
                    )
                  );
                  break;

                case "error":
                  setError(data.error);
                  break;
              }
            } catch {
              // skip parse errors in SSE
            }
          }
        }
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to send message"
      );
    } finally {
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  }, [input, isStreaming, activeAgentId, activeSessionId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
    <div className="app-layout">
      {/* Sidebar */}
      <Sidebar>
        {/* Agent Selector */}
        <div className="sidebar-section">
          <div className="sidebar-section-title">Active Agent</div>
          {agents.map((agent) => (
            <button
              key={agent.id}
              className={`sidebar-item ${agent.id === activeAgentId ? "active" : ""}`}
              onClick={() => {
                setActiveAgentId(agent.id);
                newChat();
              }}
            >
              <span className="sidebar-item-icon">🤖</span>
              <span className="sidebar-item-text">{agent.name}</span>
            </button>
          ))}
        </div>

        {/* Session History */}
        <div className="sidebar-section">
          <div className="sidebar-section-title">History</div>
          {sessions.slice(0, 20).map((s) => (
            <button
              key={s.id}
              className={`sidebar-item ${s.id === activeSessionId ? "active" : ""}`}
              onClick={() => {
                // Switch to the session's agent if different
                if (s.agentId && s.agentId !== activeAgentId) {
                  setActiveAgentId(s.agentId);
                }
                setActiveSessionId(s.id);
              }}
            >
              <span className="sidebar-item-icon">💬</span>
              <span className="sidebar-item-text">
                {s.title || "New conversation"}
              </span>
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <button className="new-chat-btn" onClick={newChat}>
            ✨ New Chat
          </button>
        </div>
      </Sidebar>

      {/* Main Content */}
      <main className="main-content">
        {/* Header */}
        <header className="chat-header">
          <div className="chat-header-title">
            <h2>{activeAgent?.name || "OpenAcme Agent"}</h2>
            {activeAgent && (
              <span className="chat-header-model">
                {activeAgent.model.provider}/{activeAgent.model.model}
              </span>
            )}
          </div>
        </header>

        {/* Error Banner */}
        {error && (
          <div
            style={{
              padding: "10px 24px",
              background: "rgba(239,68,68,0.1)",
              borderBottom: "1px solid rgba(239,68,68,0.2)",
              color: "#ef4444",
              fontSize: "13px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            ⚠️ {error}
            <button
              onClick={() => setError("")}
              style={{
                marginLeft: "auto",
                background: "none",
                border: "none",
                color: "#ef4444",
                cursor: "pointer",
                fontSize: "16px",
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* Messages */}
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⚡</div>
            <h3>Start a conversation</h3>
            <p>
              Chat with your AI agent. It can execute commands, read and write
              files, and use tools to help you.
            </p>
          </div>
        ) : (
          <div className="chat-messages">
            {messages.map((msg) => (
              <div key={msg.id} className="message">
                <div
                  className={`message-avatar ${msg.role}`}
                >
                  {msg.role === "user" ? "👤" : "⚡"}
                </div>
                <div className="message-body">
                  <div className="message-role">{msg.role}</div>

                  {/* Tool calls */}
                  {msg.toolCalls?.map((tc, i) => (
                    <div key={i} className="tool-card">
                      <div className="tool-card-header">
                        🔧 {tc.toolName}
                      </div>
                      <div className="tool-card-args">
                        {JSON.stringify(tc.args, null, 2)}
                      </div>
                      {tc.result && (
                        <div className="tool-card-result">
                          {tc.result.length > 500
                            ? tc.result.slice(0, 500) + "..."
                            : tc.result}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Message content */}
                  <div className="message-content">
                    {msg.content}
                    {isStreaming &&
                      msg.role === "assistant" &&
                      msg.id === messages[messages.length - 1]?.id && (
                        <span className="streaming-cursor" />
                      )}
                  </div>
                </div>
              </div>
            ))}

            {/* Thinking indicator */}
            {isStreaming &&
              messages[messages.length - 1]?.role === "assistant" &&
              !messages[messages.length - 1]?.content &&
              !messages[messages.length - 1]?.toolCalls?.length && (
                <div className="message">
                  <div className="message-avatar assistant">⚡</div>
                  <div className="message-body">
                    <div className="thinking">
                      <div className="thinking-dots">
                        <span />
                        <span />
                        <span />
                      </div>
                      Thinking...
                    </div>
                  </div>
                </div>
              )}

            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Input */}
        <div className="chat-input-container">
          <div className="chat-input-wrapper">
            <textarea
              ref={inputRef}
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                activeAgent
                  ? `Message ${activeAgent.name}...`
                  : "Select an agent to start..."
              }
              disabled={isStreaming || !activeAgentId}
              rows={1}
            />
            <button
              className="chat-send-btn"
              onClick={sendMessage}
              disabled={isStreaming || !input.trim() || !activeAgentId}
              title="Send message"
            >
              ↑
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
