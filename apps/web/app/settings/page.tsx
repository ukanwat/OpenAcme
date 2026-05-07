"use client";

import { useState, useEffect } from "react";
import { Sidebar } from "../components/Sidebar";

interface ServerConfig {
  dataDir: string;
  server: { port: number; host: string };
  behavior: { maxSteps: number; maxIterations: number };
  skills: { directory: string; autoGenerate: boolean };
}

interface Provider {
  id: string;
  name: string;
  requiresApiKey: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
}

// Use same origin when served from the API server, otherwise fallback to localhost
const API_BASE = typeof window !== "undefined" && window.location.port === "3210"
  ? ""
  : (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3210");

export default function SettingsPage() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, boolean>>({});
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    loadConfig();
    loadProviders();
    loadConfiguredKeys();
  }, []);

  const loadConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/config`);
      if (res.ok) {
        setConfig(await res.json());
      }
    } catch {
      setError("Failed to load server config");
    }
  };

  const loadProviders = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/models`);
      if (res.ok) {
        setProviders(await res.json());
      }
    } catch {
      // Server may not have /api/models endpoint yet
    }
  };

  const loadConfiguredKeys = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/keys`);
      if (res.ok) {
        const data = await res.json();
        setConfiguredKeys(data.configured || {});
      }
    } catch {
      // Keys endpoint may not exist yet
    }
  };

  const saveApiKey = async (provider: string) => {
    const apiKey = apiKeyInputs[provider];
    if (!apiKey?.trim()) {
      setError("Please enter an API key");
      return;
    }

    setSaving(provider);
    setError("");

    try {
      const res = await fetch(`${API_BASE}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
      });

      if (res.ok) {
        setSuccess(`${provider} API key saved to server`);
        setApiKeyInputs({ ...apiKeyInputs, [provider]: "" });
        setConfiguredKeys({ ...configuredKeys, [provider]: true });
        setTimeout(() => setSuccess(""), 3000);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to save API key");
      }
    } catch {
      setError("Failed to save API key");
    } finally {
      setSaving(null);
    }
  };

  // Get providers that need API keys
  const providersNeedingKeys = providers.filter((p) => p.requiresApiKey && p.envVar);

  return (
    <div className="app-layout">
      <Sidebar />

      <main className="main-content">
        <header className="chat-header">
          <div className="chat-header-title">
            <h2>Settings</h2>
          </div>
        </header>

        <div className="settings-container">
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
              <button
                onClick={() => setError("")}
                style={{
                  marginLeft: "12px",
                  background: "none",
                  border: "none",
                  color: "#ef4444",
                  cursor: "pointer",
                }}
              >
                Dismiss
              </button>
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

          {/* API Keys Section */}
          <div className="settings-group">
            <h3>API Keys</h3>
            <p
              style={{
                fontSize: "13px",
                color: "var(--text-secondary)",
                marginBottom: "16px",
              }}
            >
              API keys are saved to <code style={{ background: "var(--bg-tertiary)", padding: "2px 6px", borderRadius: "4px" }}>{config?.dataDir || "~/.openacme"}/.env</code> on the server.
              Both the CLI and web app use the same keys.
            </p>

            {providersNeedingKeys.map((provider) => (
              <div className="settings-field" key={provider.id}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {provider.name} ({provider.envVar})
                  {configuredKeys[provider.id] && (
                    <span
                      style={{
                        color: "#22c55e",
                        fontSize: "12px",
                        background: "rgba(34,197,94,0.1)",
                        padding: "2px 8px",
                        borderRadius: "4px",
                      }}
                    >
                      Configured
                    </span>
                  )}
                </label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="password"
                    value={apiKeyInputs[provider.id] || ""}
                    onChange={(e) =>
                      setApiKeyInputs({ ...apiKeyInputs, [provider.id]: e.target.value })
                    }
                    placeholder={configuredKeys[provider.id] ? "Enter new key to update" : `Enter ${provider.envVar}`}
                    style={{ flex: 1 }}
                  />
                  <button
                    onClick={() => saveApiKey(provider.id)}
                    disabled={saving === provider.id || !apiKeyInputs[provider.id]?.trim()}
                    style={{
                      padding: "10px 16px",
                      borderRadius: "8px",
                      background: apiKeyInputs[provider.id]?.trim()
                        ? "var(--accent-primary)"
                        : "var(--bg-tertiary)",
                      border: "1px solid var(--border)",
                      color: apiKeyInputs[provider.id]?.trim()
                        ? "white"
                        : "var(--text-primary)",
                      cursor: apiKeyInputs[provider.id]?.trim() ? "pointer" : "not-allowed",
                      opacity: saving === provider.id ? 0.7 : 1,
                    }}
                  >
                    {saving === provider.id ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Server Configuration */}
          {config && (
            <div className="settings-group">
              <h3>Server Configuration</h3>
              <p
                style={{
                  fontSize: "13px",
                  color: "var(--text-secondary)",
                  marginBottom: "16px",
                }}
              >
                These settings are read from config.yaml and cannot be changed from
                the UI.
              </p>

              <div
                style={{
                  background: "var(--bg-tertiary)",
                  borderRadius: "8px",
                  padding: "16px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "13px",
                }}
              >
                <div style={{ marginBottom: "8px" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Data Directory:</span>{" "}
                  <span style={{ color: "var(--text-primary)" }}>{config.dataDir}</span>
                </div>
                <div style={{ marginBottom: "8px" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Server:</span>{" "}
                  <span style={{ color: "var(--text-primary)" }}>
                    {config.server.host}:{config.server.port}
                  </span>
                </div>
                <div style={{ marginBottom: "8px" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Max Steps:</span>{" "}
                  <span style={{ color: "var(--text-primary)" }}>
                    {config.behavior.maxSteps}
                  </span>
                </div>
                <div style={{ marginBottom: "8px" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Max Iterations:</span>{" "}
                  <span style={{ color: "var(--text-primary)" }}>
                    {config.behavior.maxIterations}
                  </span>
                </div>
                <div>
                  <span style={{ color: "var(--text-secondary)" }}>Skills Directory:</span>{" "}
                  <span style={{ color: "var(--text-primary)" }}>
                    {config.skills.directory}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Available Providers */}
          {providers.length > 0 && (
            <div className="settings-group">
              <h3>Available Providers</h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                  gap: "12px",
                }}
              >
                {providers.map((provider) => (
                  <div
                    key={provider.id}
                    style={{
                      background: "var(--bg-tertiary)",
                      borderRadius: "8px",
                      padding: "12px",
                      border: configuredKeys[provider.id]
                        ? "1px solid rgba(34,197,94,0.5)"
                        : "1px solid var(--border)",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 500,
                        marginBottom: "8px",
                        color: "var(--text-primary)",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      {provider.name}
                      {configuredKeys[provider.id] && (
                        <span style={{ color: "#22c55e" }}>OK</span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: "12px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {provider.requiresApiKey ? provider.envVar : "No API key needed"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* MCP Configuration */}
          <div className="settings-group">
            <h3>MCP Servers</h3>
            <p
              style={{
                fontSize: "13px",
                color: "var(--text-secondary)",
                marginBottom: "16px",
              }}
            >
              MCP servers are configured in config.yaml under each agent&apos;s
              mcpServers section. Edit the config file directly to add or modify
              MCP connections.
            </p>
            <div
              style={{
                background: "var(--bg-tertiary)",
                borderRadius: "8px",
                padding: "16px",
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                color: "var(--text-secondary)",
              }}
            >
              <pre style={{ margin: 0 }}>{`# Example config.yaml MCP section:
agents:
  - id: default
    name: Default Agent
    mcpServers:
      filesystem:
        command: npx
        args:
          - -y
          - "@modelcontextprotocol/server-filesystem"
          - /path/to/allowed/dir`}</pre>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
