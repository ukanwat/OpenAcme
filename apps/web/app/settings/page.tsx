"use client";

import { useState, useEffect } from "react";
import { Check, Key, Server, Cpu, Boxes, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
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

export default function SettingsPage() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, boolean>>({});
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    loadConfig(ctrl.signal);
    loadProviders(ctrl.signal);
    loadConfiguredKeys(ctrl.signal);
    return () => ctrl.abort();
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

  const providersNeedingKeys = providers.filter((p) => p.requiresApiKey && p.envVar);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center border-b px-6">
          <div>
            <h2 className="text-sm font-semibold">Settings</h2>
            <p className="text-xs text-muted-foreground">
              Configure providers, server, and integrations
            </p>
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
              </TabsList>

              <TabsContent value="api-keys">
                <Card>
                  <CardHeader>
                    <CardTitle>API Keys</CardTitle>
                    <CardDescription>
                      Saved to{" "}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {config?.dataDir || "~/.openacme"}/.env
                      </code>{" "}
                      on the server. Both the CLI and web app use the same keys.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {providersNeedingKeys.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        Loading providers…
                      </p>
                    )}
                    {providersNeedingKeys.map((provider) => (
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
                              <Loader2 className="size-4 animate-spin" />
                            )}
                            Save
                          </Button>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="server">
                <Card>
                  <CardHeader>
                    <CardTitle>Server configuration</CardTitle>
                    <CardDescription>
                      Read from <code className="font-mono">config.yaml</code>. Edit the
                      file to change these.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {config ? (
                      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 text-sm">
                        <div>
                          <dt className="text-xs uppercase text-muted-foreground">
                            Data directory
                          </dt>
                          <dd className="mt-0.5 font-mono text-foreground break-all">
                            {config.dataDir}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs uppercase text-muted-foreground">
                            Server
                          </dt>
                          <dd className="mt-0.5 font-mono text-foreground">
                            {config.server.host}:{config.server.port}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs uppercase text-muted-foreground">
                            Max steps
                          </dt>
                          <dd className="mt-0.5 font-mono text-foreground">
                            {config.behavior.maxSteps}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs uppercase text-muted-foreground">
                            Max iterations
                          </dt>
                          <dd className="mt-0.5 font-mono text-foreground">
                            {config.behavior.maxIterations}
                          </dd>
                        </div>
                        <div className="sm:col-span-2">
                          <dt className="text-xs uppercase text-muted-foreground">
                            Skills directory
                          </dt>
                          <dd className="mt-0.5 font-mono text-foreground break-all">
                            {config.skills.directory}
                          </dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="text-sm text-muted-foreground">Loading…</p>
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
                      <p className="text-sm text-muted-foreground">Loading…</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {providers.map((provider) => (
                          <div
                            key={provider.id}
                            className="rounded-lg border p-3"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">
                                {provider.name}
                              </span>
                              {configuredKeys[provider.id] && (
                                <Check className="size-3.5 text-green-500" />
                              )}
                            </div>
                            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
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
                  <CardHeader>
                    <CardTitle>MCP servers</CardTitle>
                    <CardDescription>
                      Configured per agent in <code className="font-mono">config.yaml</code>{" "}
                      under the agent&apos;s <code className="font-mono">mcpServers</code>{" "}
                      section.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <pre className="overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
{`agents:
  - id: default
    name: Default Agent
    mcpServers:
      filesystem:
        command: npx
        args:
          - -y
          - "@modelcontextprotocol/server-filesystem"
          - /path/to/allowed/dir`}
                    </pre>
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
