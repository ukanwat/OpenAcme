"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Key,
  Server,
  Cpu,
  Boxes,
  Pencil,
  Plug,
  RefreshCw,
  Trash2,
  Plus,
  FileJson,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import {
  MCPServerForm,
  type MCPServerConfigDto,
  type MCPServerFormValue,
} from "../components/MCPServerForm";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Textarea } from "@/app/components/ui/textarea";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { Badge } from "@/app/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";

interface ServerConfig {
  dataDir: string;
  server: { port: number; host: string };
  behavior: { maxSteps: number };
  skills: { directory: string; autoGenerate: boolean };
}

interface Provider {
  id: string;
  name: string;
  requiresApiKey: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
}

interface McpServerStatus {
  name: string;
  state: "disabled" | "disconnected" | "connecting" | "connected" | "failed" | "awaiting_oauth";
  connected: boolean;
  toolCount: number;
  tools: string[];
  lastError?: string;
  attemptCount: number;
  transport?: "http" | "sse" | "stdio";
}

interface McpStatusPayload {
  agents: { agentId: string; servers: McpServerStatus[] }[];
}

/**
 * Aggregate status across every agent for one server name. A global server
 * shows up in every agent's MCP client; we want one row in the UI.
 */
function aggregateStatus(
  name: string,
  status: McpStatusPayload | null
): McpServerStatus | null {
  if (!status) return null;
  const matches: McpServerStatus[] = [];
  for (const a of status.agents) {
    for (const s of a.servers) {
      if (s.name === name) matches.push(s);
    }
  }
  if (matches.length === 0) return null;
  // Prefer the most-informative entry: connected > awaiting_oauth > failed >
  // connecting > disconnected > disabled.
  const order: McpServerStatus["state"][] = [
    "connected",
    "awaiting_oauth",
    "failed",
    "connecting",
    "disconnected",
    "disabled",
  ];
  matches.sort(
    (a, b) => order.indexOf(a.state) - order.indexOf(b.state)
  );
  return matches[0] ?? null;
}

function statePillClass(state: McpServerStatus["state"]): string {
  switch (state) {
    case "connected":
      return "bg-paper text-ink border border-plot-red";
    case "awaiting_oauth":
      return "bg-paper text-warn-ochre border border-warn-ochre";
    case "failed":
      return "bg-paper text-destructive border border-destructive";
    case "connecting":
      return "bg-paper text-plot-red border border-plot-red pulse-live";
    case "disabled":
      return "bg-paper-sunk text-ink-faint border border-paper-rule";
    default:
      return "bg-paper-sunk text-ink-soft border border-paper-rule";
  }
}

export default function SettingsPage() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, boolean>>({});
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  // Subscription paths: state shared by Anthropic Claude Code import + OpenAI
  // ChatGPT OAuth (both surfaced inline with the API-key field, below).
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false);
  const [subAction, setSubAction] = useState<string | null>(null);

  // MCP state — global catalog + aggregated per-server status across agents.
  const [mcpServers, setMcpServers] = useState<Record<string, MCPServerConfigDto>>({});
  const [mcpStatus, setMcpStatus] = useState<McpStatusPayload | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpDialog, setMcpDialog] = useState<
    | { mode: "add" }
    | { mode: "edit"; initial: MCPServerFormValue }
    | null
  >(null);
  const [mcpRefreshing, setMcpRefreshing] = useState<string | null>(null);
  // Raw-JSON editor state — for users who'd rather paste/edit verbatim
  // than use the dialog form. Saves to PUT /api/mcp/global which validates.
  const [mcpJsonOpen, setMcpJsonOpen] = useState(false);
  const [mcpJsonText, setMcpJsonText] = useState("");
  const [mcpJsonError, setMcpJsonError] = useState<string | null>(null);
  const [mcpJsonSaving, setMcpJsonSaving] = useState(false);

  // AGENTS.md — shared context for every agent. null = file absent.
  const [agentsMd, setAgentsMd] = useState<string | null>(null);
  const [agentsMdDraft, setAgentsMdDraft] = useState("");
  const [agentsMdSaving, setAgentsMdSaving] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    loadConfig(ctrl.signal);
    loadProviders(ctrl.signal);
    loadConfiguredKeys(ctrl.signal);
    loadMcp(ctrl.signal);
    loadAgentsMd(ctrl.signal);
    return () => ctrl.abort();
    // loadMcp is useCallback-stabilized; intentionally run-once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll MCP status while the MCP tab is visible — connection states change
  // as servers reconnect or hit OAuth flows. 4s is fast enough that the UI
  // feels live without hammering the server.
  useEffect(() => {
    const id = setInterval(() => {
      loadMcpStatus().catch(() => {});
    }, 4000);
    return () => clearInterval(id);
    // loadMcpStatus is useCallback-stabilized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadConfig = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/config`, { signal });
      if (res.ok) setConfig(await res.json());
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load server config");
    }
  };

  const loadProviders = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/models`, { signal });
      if (res.ok) setProviders(await res.json());
    } catch {
      // /api/models may not exist on older servers — fail silently
    }
  };

  const loadConfiguredKeys = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/keys`, { signal });
      if (res.ok) {
        const data = await res.json();
        setConfiguredKeys(data.configured || {});
      }
    } catch {
      // /api/keys may not exist on older servers — fail silently
    }
  };

  // Probe whether the daemon can offer Claude Code keychain import. Cheap
  // file-existence check on the server, no Touch-ID prompt.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/setup/claude-code-available`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.available === "boolean") {
          setClaudeCodeAvailable(data.available);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ChatGPT OAuth — long-polls until the daemon's loopback callback completes.
  const signInWithOpenAI = async () => {
    setSubAction("openai");
    toast.message("Opened your browser to sign in", {
      description: "Complete the flow there. This panel will update when done.",
    });
    try {
      const r = await fetch(`${API_BASE}/api/setup/oauth-start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai" }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        error?: string;
        email?: string | null;
      };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success(
        data.email ? `Signed in as ${data.email}` : "ChatGPT subscription linked"
      );
      setConfiguredKeys((prev) => ({ ...prev, openai: true }));
    } catch (e) {
      toast.error("Sign-in failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubAction(null);
    }
  };

  // Anthropic — import the credentials Claude Code already wrote on this
  // machine. On macOS the OS prompts for Touch ID to unlock the keychain.
  const importClaudeCode = async () => {
    setSubAction("anthropic");
    try {
      const r = await fetch(
        `${API_BASE}/api/setup/anthropic-claude-code-import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ importNow: true }),
        }
      );
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success("Imported from Claude Code");
      setConfiguredKeys((prev) => ({ ...prev, anthropic: true }));
    } catch (e) {
      toast.error("Import failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubAction(null);
    }
  };

  const loadAgentsMd = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/agents-md`, { signal });
      if (!res.ok) return;
      const data = (await res.json()) as { content: string | null };
      setAgentsMd(data.content);
      setAgentsMdDraft(data.content ?? "");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // Fail silently; older servers may not have this endpoint.
    }
  };

  const saveAgentsMd = async () => {
    setAgentsMdSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/agents-md`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: agentsMdDraft }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to save AGENTS.md");
        return;
      }
      const data = (await res.json()) as { content: string | null };
      setAgentsMd(data.content);
      setAgentsMdDraft(data.content ?? "");
      toast.success(
        data.content === null ? "AGENTS.md cleared" : "AGENTS.md saved"
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAgentsMdSaving(false);
    }
  };

  const saveApiKey = async (provider: string) => {
    const apiKey = apiKeyInputs[provider];
    if (!apiKey?.trim()) {
      toast.error("Please enter an API key");
      return;
    }
    setSaving(provider);
    try {
      const res = await fetch(`${API_BASE}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
      });
      if (res.ok) {
        toast.success(`${provider} key saved`);
        setApiKeyInputs({ ...apiKeyInputs, [provider]: "" });
        setConfiguredKeys({ ...configuredKeys, [provider]: true });
      } else {
        const data = await res.json();
        toast.error("Failed to save API key", { description: data.error });
      }
    } catch {
      toast.error("Failed to save API key");
    } finally {
      setSaving(null);
    }
  };

  // ── MCP ──

  const loadMcp = useCallback(async (signal?: AbortSignal) => {
    setMcpLoading(true);
    try {
      const [g, s] = await Promise.all([
        fetch(`${API_BASE}/api/mcp/global`, { signal }).then((r) => r.json()),
        fetch(`${API_BASE}/api/mcp/status`, { signal }).then((r) => r.json()),
      ]);
      setMcpServers(g.mcpServers ?? {});
      setMcpStatus(s as McpStatusPayload);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load MCP servers");
    } finally {
      setMcpLoading(false);
    }
  }, []);

  const loadMcpStatus = useCallback(async () => {
    const res = await fetch(`${API_BASE}/api/mcp/status`);
    if (res.ok) setMcpStatus((await res.json()) as McpStatusPayload);
  }, []);

  const saveGlobalServers = async (
    next: Record<string, MCPServerConfigDto>
  ) => {
    const res = await fetch(`${API_BASE}/api/mcp/global`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpServers: next }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    return ((await res.json()).mcpServers ?? {}) as Record<string, MCPServerConfigDto>;
  };

  const handleMcpSubmit = async (value: MCPServerFormValue) => {
    const next: Record<string, MCPServerConfigDto> = { ...mcpServers };
    next[value.name] = value.config;
    try {
      const saved = await saveGlobalServers(next);
      setMcpServers(saved);
      setMcpDialog(null);
      toast.success(`Saved '${value.name}'`);
      await loadMcpStatus();
    } catch (e) {
      toast.error("Save failed", { description: (e as Error).message });
    }
  };

  const handleMcpDelete = async (name: string) => {
    if (!confirm(`Remove MCP server '${name}'? This affects every agent.`)) return;
    const next: Record<string, MCPServerConfigDto> = { ...mcpServers };
    delete next[name];
    try {
      const saved = await saveGlobalServers(next);
      setMcpServers(saved);
      toast.success(`Removed '${name}'`);
      await loadMcpStatus();
    } catch (e) {
      toast.error("Delete failed", { description: (e as Error).message });
    }
  };

  const handleMcpToggleEnabled = async (name: string) => {
    const cur = mcpServers[name];
    if (!cur) return;
    const next: Record<string, MCPServerConfigDto> = {
      ...mcpServers,
      [name]: { ...cur, enabled: cur.enabled === false ? true : false },
    };
    try {
      const saved = await saveGlobalServers(next);
      setMcpServers(saved);
      await loadMcpStatus();
    } catch (e) {
      toast.error("Update failed", { description: (e as Error).message });
    }
  };

  const handleMcpReconnect = async (name: string) => {
    if (!mcpStatus) return;
    setMcpRefreshing(name);
    try {
      // Reconnect on every agent that has this server.
      const targets = mcpStatus.agents.filter((a) =>
        a.servers.some((s) => s.name === name)
      );
      await Promise.all(
        targets.map((a) =>
          fetch(`${API_BASE}/api/agents/${a.agentId}/mcp/servers/${encodeURIComponent(name)}/reconnect`, {
            method: "POST",
          })
        )
      );
      toast.success(`Reconnecting '${name}'`);
      await loadMcpStatus();
    } catch (e) {
      toast.error("Reconnect failed", { description: (e as Error).message });
    } finally {
      setMcpRefreshing(null);
    }
  };

  const handleMcpTest = async (
    value: MCPServerFormValue
  ): Promise<{ ok: boolean; error?: string; tools?: string[]; transport?: string }> => {
    const res = await fetch(`${API_BASE}/api/mcp/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value.config),
    });
    return await res.json();
  };

  const openMcpJsonEditor = () => {
    setMcpJsonText(
      JSON.stringify({ mcpServers: mcpServers }, null, 2)
    );
    setMcpJsonError(null);
    setMcpJsonOpen(true);
  };

  const saveMcpJson = async () => {
    setMcpJsonError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(mcpJsonText);
    } catch (e) {
      setMcpJsonError(`JSON parse error: ${(e as Error).message}`);
      return;
    }
    // Tolerate either { mcpServers: {...} } or { ...directly... }, matching
    // what people commonly paste from Claude Desktop / Cursor.
    const body: { mcpServers: unknown } =
      parsed &&
      typeof parsed === "object" &&
      "mcpServers" in (parsed as Record<string, unknown>)
        ? (parsed as { mcpServers: unknown })
        : { mcpServers: parsed };

    setMcpJsonSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/mcp/global`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = Array.isArray(data.details)
          ? `\n${data.details.join("\n")}`
          : "";
        setMcpJsonError(`${data.error ?? `HTTP ${res.status}`}${detail}`);
        return;
      }
      setMcpServers(data.mcpServers ?? {});
      setMcpJsonOpen(false);
      toast.success("Saved mcp.json");
      await loadMcpStatus();
    } catch (e) {
      setMcpJsonError((e as Error).message);
    } finally {
      setMcpJsonSaving(false);
    }
  };

  const providersNeedingKeys = providers.filter((p) => p.requiresApiKey && p.envVar);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center border-b border-paper-rule px-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Settings
            </span>
            <span className="h-3 w-px bg-paper-rule" aria-hidden />
            <span className="font-mono text-[12px] text-ink-soft">
              Providers · Server · MCP
            </span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-3xl">
            <Tabs defaultValue="api-keys" className="space-y-6">
              <TabsList>
                <TabsTrigger value="api-keys">
                  <Key className="size-3.5" />
                  API Keys
                </TabsTrigger>
                <TabsTrigger value="server">
                  <Server className="size-3.5" />
                  Server
                </TabsTrigger>
                <TabsTrigger value="providers">
                  <Cpu className="size-3.5" />
                  Providers
                </TabsTrigger>
                <TabsTrigger value="mcp">
                  <Boxes className="size-3.5" />
                  MCP
                </TabsTrigger>
                <TabsTrigger value="context">
                  <FileText className="size-3.5" />
                  Context
                </TabsTrigger>
              </TabsList>

              <TabsContent value="api-keys">
                <Card>
                  <CardHeader>
                    <CardTitle>API Keys</CardTitle>
                    <CardDescription>
                      Saved to{" "}
                      <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">
                        {config?.dataDir || "~/.openacme"}/.env
                      </code>{" "}
                      on the server. Both the CLI and web app use the same keys.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {providersNeedingKeys.length === 0 && (
                      <p className="font-mono text-[12px] text-ink-faint">
                        Loading providers…
                      </p>
                    )}
                    {providersNeedingKeys.map((provider) => {
                      const subscriptionLabel =
                        provider.id === "openai"
                          ? "Sign in with ChatGPT"
                          : provider.id === "anthropic" && claudeCodeAvailable
                            ? "Import from Claude Code"
                            : null;
                      const subHandler =
                        provider.id === "openai"
                          ? signInWithOpenAI
                          : provider.id === "anthropic"
                            ? importClaudeCode
                            : null;
                      const subBusy = subAction === provider.id;
                      return (
                        <div key={provider.id} className="grid gap-2">
                          <div className="flex items-center gap-2">
                            <Label htmlFor={`key-${provider.id}`}>
                              {provider.name}
                            </Label>
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {provider.envVar}
                            </span>
                            {configuredKeys[provider.id] && (
                              <Badge variant="secondary" className="ml-auto gap-1">
                                <Check className="size-3" />
                                Configured
                              </Badge>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <Input
                              id={`key-${provider.id}`}
                              type="password"
                              value={apiKeyInputs[provider.id] || ""}
                              onChange={(e) =>
                                setApiKeyInputs({
                                  ...apiKeyInputs,
                                  [provider.id]: e.target.value,
                                })
                              }
                              placeholder={
                                configuredKeys[provider.id]
                                  ? "Enter new key to update"
                                  : `Enter ${provider.envVar}`
                              }
                            />
                            <Button
                              onClick={() => saveApiKey(provider.id)}
                              disabled={
                                saving === provider.id ||
                                !apiKeyInputs[provider.id]?.trim()
                              }
                            >
                              {saving === provider.id && (
                                <LoadingHairline inline />
                              )}
                              Save
                            </Button>
                          </div>
                          {subscriptionLabel && subHandler && (
                            <div className="flex items-center justify-between gap-3 pt-1 font-mono text-[11px] text-ink-faint">
                              <span>
                                {provider.id === "anthropic"
                                  ? "Or use Claude Code keychain (Touch ID may prompt)"
                                  : "Or use your existing subscription"}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={subHandler}
                                disabled={subBusy}
                              >
                                {subBusy && <LoadingHairline inline />}
                                {subscriptionLabel}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="server">
                <Card>
                  <CardHeader>
                    <CardTitle>Server configuration</CardTitle>
                    <CardDescription>
                      Read from{" "}
                      <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">
                        config.yaml
                      </code>
                      . Edit the file to change these.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {config ? (
                      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 font-mono text-[12px] tabular-nums">
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Data dir
                        </dt>
                        <dd className="text-ink-soft break-all">
                          {config.dataDir}
                        </dd>
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Server
                        </dt>
                        <dd className="text-ink-soft">
                          {config.server.host}:{config.server.port}
                        </dd>
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Max steps
                        </dt>
                        <dd className="text-ink-soft">
                          {config.behavior.maxSteps}
                        </dd>
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Skills dir
                        </dt>
                        <dd className="text-ink-soft break-all">
                          {config.skills.directory}
                        </dd>
                      </dl>
                    ) : (
                      <p className="font-mono text-[12px] text-ink-faint">Loading…</p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="providers">
                <Card>
                  <CardHeader>
                    <CardTitle>Available providers</CardTitle>
                    <CardDescription>
                      Models the platform can talk to. Configure API keys above.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {providers.length === 0 ? (
                      <p className="font-mono text-[12px] text-ink-faint">Loading…</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-px bg-paper-rule sm:grid-cols-3">
                        {providers.map((provider) => (
                          <div
                            key={provider.id}
                            className="bg-paper p-3"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-ink">
                                {provider.name}
                              </span>
                              {configuredKeys[provider.id] && (
                                <Check className="size-3.5 text-plot-red" />
                              )}
                            </div>
                            <div className="mt-1 font-mono text-[11px] text-ink-faint">
                              {provider.requiresApiKey
                                ? provider.envVar
                                : "no key needed"}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="mcp">
                <Card>
                  <CardHeader className="flex flex-row items-start justify-between gap-2">
                    <div>
                      <CardTitle>MCP servers</CardTitle>
                      <CardDescription>
                        Defined in{" "}
                        <code className="font-mono text-ink">
                          {config?.dataDir ?? "~/.openacme"}/mcp.json
                        </code>
                        . Inherited by every agent. Per-agent exclusions and
                        agent-private servers live on each agent.
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={openMcpJsonEditor}
                        title="Edit raw mcp.json"
                      >
                        <FileJson className="size-4" />
                        Edit JSON
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setMcpDialog({ mode: "add" })}
                      >
                        <Plus className="size-4" />
                        Add server
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {mcpLoading && Object.keys(mcpServers).length === 0 ? (
                      <p className="font-mono text-[12px] text-ink-faint">Loading…</p>
                    ) : Object.keys(mcpServers).length === 0 ? (
                      <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
                        No MCP servers configured yet. Click &ldquo;Add
                        server&rdquo; to start.
                      </p>
                    ) : (
                      <ul className="border-y border-paper-rule">
                        {Object.entries(mcpServers).map(([name, cfg]) => {
                          const status = aggregateStatus(name, mcpStatus);
                          const state =
                            cfg.enabled === false
                              ? ("disabled" as const)
                              : status?.state ?? ("disconnected" as const);
                          const transport =
                            status?.transport ?? cfg.transport ?? (cfg.command ? "stdio" : undefined);
                          return (
                            <li
                              key={name}
                              className="flex flex-col gap-2 border-b border-paper-rule last:border-b-0 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono text-sm text-ink">
                                    {name}
                                  </span>
                                  <span
                                    className={`px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] ${statePillClass(state)}`}
                                  >
                                    {state}
                                  </span>
                                  {transport && (
                                    <Badge variant="outline">
                                      {transport}
                                    </Badge>
                                  )}
                                  {status && status.toolCount > 0 && (
                                    <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                                      {status.toolCount} tools
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
                                  {cfg.command
                                    ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
                                    : cfg.url ?? ""}
                                </div>
                                {status?.lastError && (
                                  <div className="mt-1 font-mono text-[11px] text-destructive line-clamp-2">
                                    {status.lastError}
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleMcpReconnect(name)}
                                  disabled={mcpRefreshing === name || cfg.enabled === false}
                                  title="Reconnect"
                                >
                                  {mcpRefreshing === name ? (
                                    <LoadingHairline inline />
                                  ) : (
                                    <RefreshCw className="size-4" />
                                  )}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleMcpToggleEnabled(name)}
                                  title={cfg.enabled === false ? "Enable" : "Disable"}
                                >
                                  <Plug className="size-4" />
                                  {cfg.enabled === false ? "Enable" : "Disable"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setMcpDialog({
                                      mode: "edit",
                                      initial: { name, config: cfg },
                                    })
                                  }
                                  title="Edit"
                                >
                                  <Pencil className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleMcpDelete(name)}
                                  title="Delete"
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </CardContent>
                </Card>

                <Dialog
                  open={mcpDialog !== null}
                  onOpenChange={(open) => {
                    if (!open) setMcpDialog(null);
                  }}
                >
                  <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>
                        {mcpDialog?.mode === "edit"
                          ? `Edit '${mcpDialog.initial.name}'`
                          : "Add MCP server"}
                      </DialogTitle>
                      <DialogDescription>
                        Same JSON shape Claude Desktop / Cursor / Cline use —
                        you can paste configs from those apps directly.
                      </DialogDescription>
                    </DialogHeader>
                    {mcpDialog && (
                      <DialogBody>
                        <MCPServerForm
                          initial={
                            mcpDialog.mode === "edit"
                              ? mcpDialog.initial
                              : undefined
                          }
                          lockName={mcpDialog.mode === "edit"}
                          reservedNames={
                            mcpDialog.mode === "add"
                              ? Object.keys(mcpServers)
                              : []
                          }
                          onSubmit={handleMcpSubmit}
                          onCancel={() => setMcpDialog(null)}
                          onTest={handleMcpTest}
                        />
                      </DialogBody>
                    )}
                  </DialogContent>
                </Dialog>

                <Dialog
                  open={mcpJsonOpen}
                  onOpenChange={(open) => {
                    if (!open) setMcpJsonOpen(false);
                  }}
                >
                  <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>Edit mcp.json</DialogTitle>
                      <DialogDescription>
                        Same JSON shape Claude Desktop, Cursor, and Cline use.
                        Paste a config from any of those, or hand-edit. Validated
                        on save — invalid configs aren&apos;t persisted.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogBody className="grid gap-3">
                      <Textarea
                        value={mcpJsonText}
                        onChange={(e) => {
                          setMcpJsonText(e.target.value);
                          setMcpJsonError(null);
                        }}
                        rows={20}
                        spellCheck={false}
                        className="font-mono text-[12px]"
                      />
                      {mcpJsonError && (
                        <pre className="whitespace-pre-wrap border border-destructive bg-paper-sunk p-3 font-mono text-[12px] text-destructive">
                          {mcpJsonError}
                        </pre>
                      )}
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => setMcpJsonOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button onClick={saveMcpJson} disabled={mcpJsonSaving}>
                          {mcpJsonSaving && (
                            <LoadingHairline inline />
                          )}
                          Save
                        </Button>
                      </div>
                    </DialogBody>
                  </DialogContent>
                </Dialog>
              </TabsContent>

              <TabsContent value="context">
                <Card>
                  <CardHeader>
                    <CardTitle>Shared context (AGENTS.md)</CardTitle>
                    <CardDescription>
                      Optional. If set, prepended to every agent's system prompt
                      after its persona. Leave blank to remove the file. Saves
                      to{" "}
                      <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">
                        {config?.dataDir || "~/.openacme"}/AGENTS.md
                      </code>
                      .
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Textarea
                      value={agentsMdDraft}
                      onChange={(e) => setAgentsMdDraft(e.target.value)}
                      placeholder="Describe what this setup is, what it's for, anything every agent should know…"
                      rows={14}
                      className="font-mono text-[12px]"
                    />
                    <div className="flex items-center justify-between">
                      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        {agentsMd === null ? "Not set" : "Saved"} ·{" "}
                        {agentsMdDraft.length} chars
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => setAgentsMdDraft(agentsMd ?? "")}
                          disabled={
                            agentsMdSaving || agentsMdDraft === (agentsMd ?? "")
                          }
                        >
                          Reset
                        </Button>
                        <Button
                          onClick={saveAgentsMd}
                          disabled={
                            agentsMdSaving || agentsMdDraft === (agentsMd ?? "")
                          }
                        >
                          {agentsMdSaving && <LoadingHairline inline />}
                          Save
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </main>
    </div>
  );
}
