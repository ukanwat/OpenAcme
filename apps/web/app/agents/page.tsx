"use client";

import { useState, useEffect } from "react";
import { Sidebar } from "../components/Sidebar";

interface Agent {
  id: string;
  name: string;
  model: { provider: string; model: string };
  persona: string;
  tools: string[];
  skills: string[];
}

// Use same origin when served from the API server, otherwise fallback to localhost
const API_BASE = typeof window !== "undefined" && window.location.port === "3210"
  ? ""
  : (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3210");

const PROVIDERS = ["openrouter", "openai", "anthropic", "google", "ollama"];
const DEFAULT_TOOLS = [
  "shell",
  "read_file",
  "write_file",
  "list_files",
  "search_files",
  "session_search",
];

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Form state
  const [formData, setFormData] = useState({
    id: "",
    name: "",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4-20250514",
    persona: "You are a helpful AI assistant.",
    tools: DEFAULT_TOOLS.join(", "),
  });

  useEffect(() => {
    loadAgents();
  }, []);

  const loadAgents = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/agents`);
      if (res.ok) {
        const data = await res.json();
        setAgents(data);
      }
    } catch {
      setError("Failed to load agents. Is the server running?");
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    try {
      const res = await fetch(`${API_BASE}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: formData.id || formData.name.toLowerCase().replace(/\s+/g, "-"),
          name: formData.name,
          model: {
            provider: formData.provider,
            model: formData.model,
          },
          persona: formData.persona,
          tools: formData.tools.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });

      if (res.ok) {
        setSuccess("Agent created successfully!");
        setIsCreating(false);
        resetForm();
        loadAgents();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to create agent");
      }
    } catch {
      setError("Failed to create agent");
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgent) return;
    setError("");
    setSuccess("");

    try {
      const res = await fetch(`${API_BASE}/api/agents/${selectedAgent.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          model: {
            provider: formData.provider,
            model: formData.model,
          },
          persona: formData.persona,
          tools: formData.tools.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });

      if (res.ok) {
        setSuccess("Agent updated successfully!");
        loadAgents();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to update agent");
      }
    } catch {
      setError("Failed to update agent");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete agent "${id}"?`)) return;
    setError("");

    try {
      const res = await fetch(`${API_BASE}/api/agents/${id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        setSuccess("Agent deleted");
        if (selectedAgent?.id === id) {
          setSelectedAgent(null);
          resetForm();
        }
        loadAgents();
      } else {
        setError("Failed to delete agent");
      }
    } catch {
      setError("Failed to delete agent");
    }
  };

  const selectAgent = (agent: Agent) => {
    setSelectedAgent(agent);
    setIsCreating(false);
    setFormData({
      id: agent.id,
      name: agent.name,
      provider: agent.model.provider,
      model: agent.model.model,
      persona: agent.persona,
      tools: agent.tools.join(", "),
    });
  };

  const resetForm = () => {
    setFormData({
      id: "",
      name: "",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-20250514",
      persona: "You are a helpful AI assistant.",
      tools: DEFAULT_TOOLS.join(", "),
    });
  };

  const startCreate = () => {
    setSelectedAgent(null);
    setIsCreating(true);
    resetForm();
  };

  return (
    <div className="app-layout">
      <Sidebar />

      <main className="main-content">
        <header className="chat-header">
          <div className="chat-header-title">
            <h2>Agent Management</h2>
          </div>
        </header>

        <div className="settings-container" style={{ maxWidth: "900px" }}>
          {/* Status messages */}
          {error && (
            <div
              style={{
                padding: "12px 16px",
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.2)",
                borderRadius: "8px",
                color: "#ef4444",
                marginBottom: "16px",
              }}
            >
              {error}
            </div>
          )}
          {success && (
            <div
              style={{
                padding: "12px 16px",
                background: "rgba(34,197,94,0.1)",
                border: "1px solid rgba(34,197,94,0.2)",
                borderRadius: "8px",
                color: "#22c55e",
                marginBottom: "16px",
              }}
            >
              {success}
            </div>
          )}

          <div style={{ display: "flex", gap: "24px" }}>
            {/* Agent List */}
            <div style={{ width: "280px", flexShrink: 0 }}>
              <div className="settings-group">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "12px",
                  }}
                >
                  <h3 style={{ margin: 0 }}>Agents</h3>
                  <button className="new-chat-btn" onClick={startCreate} style={{ width: "auto", padding: "6px 12px" }}>
                    + New
                  </button>
                </div>
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    onClick={() => selectAgent(agent)}
                    style={{
                      padding: "12px",
                      background:
                        selectedAgent?.id === agent.id
                          ? "var(--accent-glow)"
                          : "var(--bg-tertiary)",
                      borderRadius: "8px",
                      marginBottom: "8px",
                      cursor: "pointer",
                      border:
                        selectedAgent?.id === agent.id
                          ? "1px solid var(--accent-primary)"
                          : "1px solid var(--border)",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 500,
                        color: "var(--text-primary)",
                        marginBottom: "4px",
                      }}
                    >
                      {agent.name}
                    </div>
                    <div
                      style={{
                        fontSize: "12px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {agent.model.provider}/{agent.model.model.split("/").pop()}
                    </div>
                  </div>
                ))}
                {agents.length === 0 && (
                  <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>
                    No agents configured
                  </div>
                )}
              </div>
            </div>

            {/* Agent Form */}
            <div style={{ flex: 1 }}>
              {(selectedAgent || isCreating) && (
                <form onSubmit={isCreating ? handleCreate : handleUpdate}>
                  <div className="settings-group">
                    <h3>{isCreating ? "Create Agent" : "Edit Agent"}</h3>

                    <div className="settings-field">
                      <label>Name</label>
                      <input
                        type="text"
                        value={formData.name}
                        onChange={(e) =>
                          setFormData({ ...formData, name: e.target.value })
                        }
                        placeholder="My Agent"
                        required
                      />
                    </div>

                    {isCreating && (
                      <div className="settings-field">
                        <label>ID (optional, auto-generated from name)</label>
                        <input
                          type="text"
                          value={formData.id}
                          onChange={(e) =>
                            setFormData({ ...formData, id: e.target.value })
                          }
                          placeholder="my-agent"
                        />
                      </div>
                    )}

                    <div className="settings-field">
                      <label>Provider</label>
                      <select
                        value={formData.provider}
                        onChange={(e) =>
                          setFormData({ ...formData, provider: e.target.value })
                        }
                      >
                        {PROVIDERS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="settings-field">
                      <label>Model</label>
                      <input
                        type="text"
                        value={formData.model}
                        onChange={(e) =>
                          setFormData({ ...formData, model: e.target.value })
                        }
                        placeholder="anthropic/claude-sonnet-4-20250514"
                        required
                      />
                    </div>

                    <div className="settings-field">
                      <label>Persona</label>
                      <textarea
                        value={formData.persona}
                        onChange={(e) =>
                          setFormData({ ...formData, persona: e.target.value })
                        }
                        placeholder="You are a helpful AI assistant."
                        rows={3}
                        style={{
                          width: "100%",
                          padding: "10px 14px",
                          borderRadius: "8px",
                          background: "var(--bg-tertiary)",
                          border: "1px solid var(--border)",
                          color: "var(--text-primary)",
                          fontFamily: "var(--font-sans)",
                          fontSize: "14px",
                          resize: "vertical",
                        }}
                      />
                    </div>

                    <div className="settings-field">
                      <label>Tools (comma-separated)</label>
                      <input
                        type="text"
                        value={formData.tools}
                        onChange={(e) =>
                          setFormData({ ...formData, tools: e.target.value })
                        }
                        placeholder="shell, read_file, write_file"
                      />
                    </div>

                    <div style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
                      <button
                        type="submit"
                        className="new-chat-btn"
                        style={{ width: "auto", padding: "10px 20px" }}
                      >
                        {isCreating ? "Create Agent" : "Save Changes"}
                      </button>
                      {selectedAgent && (
                        <button
                          type="button"
                          onClick={() => handleDelete(selectedAgent.id)}
                          style={{
                            padding: "10px 20px",
                            borderRadius: "8px",
                            background: "rgba(239,68,68,0.1)",
                            border: "1px solid rgba(239,68,68,0.3)",
                            color: "#ef4444",
                            cursor: "pointer",
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                </form>
              )}

              {!selectedAgent && !isCreating && (
                <div
                  style={{
                    padding: "48px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                  }}
                >
                  <p>Select an agent to edit or create a new one</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
