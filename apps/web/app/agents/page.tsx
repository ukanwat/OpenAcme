"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Bot,
  Plus,
  Trash2,
  Save,
  Check,
  Pencil,
  Boxes,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import type { ToolInfo, ProviderInfo, ModelPreset } from "../lib/types";
import {
  MCPServerForm,
  type MCPServerConfigDto,
  type MCPServerFormValue,
} from "../components/MCPServerForm";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { cn } from "@/app/lib/utils";

interface Agent {
  id: string;
  name: string;
  model: { provider: string; model: string };
  persona: string;
  tools: string[];
  skills: string[];
  mcpServers?: Record<string, MCPServerConfigDto>;
  mcpDisabled?: string[];
}

interface FormState {
  id: string;
  name: string;
  provider: string;
  model: string;
  persona: string;
  tools: string[];
  mcpServers: Record<string, MCPServerConfigDto>;
  mcpDisabled: string[];
}

const CUSTOM_MODEL = "__custom__";

const FALLBACK_FORM: FormState = {
  id: "",
  name: "",
  provider: "openrouter",
  model: "",
  persona: "You are a helpful AI assistant.",
  tools: [],
  mcpServers: {},
  mcpDisabled: [],
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [globalMcp, setGlobalMcp] = useState<Record<string, MCPServerConfigDto>>({});

  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [formData, setFormData] = useState<FormState>(FALLBACK_FORM);
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [mcpDialog, setMcpDialog] = useState<
    | { mode: "add" }
    | { mode: "edit"; initial: MCPServerFormValue }
    | null
  >(null);

  // ── Loaders ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const ctrl = new AbortController();
    void loadAll(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  const loadAll = async (signal?: AbortSignal) => {
    try {
      const [agentsRes, toolsRes, providersRes, mcpRes] = await Promise.all([
        fetch(`${API_BASE}/api/agents`, { signal }),
        fetch(`${API_BASE}/api/tools`, { signal }),
        fetch(`${API_BASE}/api/models`, { signal }),
        fetch(`${API_BASE}/api/mcp/global`, { signal }),
      ]);
      if (agentsRes.ok) setAgents(await agentsRes.json());
      if (toolsRes.ok) {
        const data = (await toolsRes.json()) as { tools: ToolInfo[] };
        setTools(data.tools ?? []);
      }
      if (providersRes.ok) {
        setProviders((await providersRes.json()) as ProviderInfo[]);
      }
      if (mcpRes.ok) {
        const data = (await mcpRes.json()) as {
          mcpServers: Record<string, MCPServerConfigDto>;
        };
        setGlobalMcp(data.mcpServers ?? {});
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load page data", {
        description: "Is the server running?",
      });
    }
  };

  const reloadAgents = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/agents`);
      if (res.ok) setAgents(await res.json());
    } catch {
      /* handled by mount loader's toast */
    }
  };

  // ── Derived ──────────────────────────────────────────────────────────────
  const currentProvider = useMemo(
    () => providers.find((p) => p.id === formData.provider),
    [providers, formData.provider]
  );

  const presets: ModelPreset[] = currentProvider?.models ?? [];

  const toolsByToolset = useMemo(() => {
    const map = new Map<string, ToolInfo[]>();
    for (const t of tools) {
      const list = map.get(t.toolset) ?? [];
      list.push(t);
      map.set(t.toolset, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools]);

  // ── Form helpers ─────────────────────────────────────────────────────────
  const onProviderChange = (provider: string) => {
    const newPresets =
      providers.find((p) => p.id === provider)?.models ?? [];
    const stillValid = newPresets.some((m) => m.id === formData.model);
    setFormData((prev) => ({
      ...prev,
      provider,
      model: stillValid ? prev.model : newPresets[0]?.id ?? "",
    }));
    setIsCustomModel(stillValid ? isCustomModel : newPresets.length === 0);
  };

  const onModelSelect = (value: string) => {
    if (value === CUSTOM_MODEL) {
      setFormData((prev) => ({ ...prev, model: "" }));
      setIsCustomModel(true);
    } else {
      setFormData((prev) => ({ ...prev, model: value }));
      setIsCustomModel(false);
    }
  };

  const toggleTool = (name: string) => {
    setFormData((prev) => ({
      ...prev,
      tools: prev.tools.includes(name)
        ? prev.tools.filter((t) => t !== name)
        : [...prev.tools, name],
    }));
  };

  const buildAgentBody = () => ({
    name: formData.name,
    model: { provider: formData.provider, model: formData.model },
    persona: formData.persona,
    tools: formData.tools,
    mcpServers: formData.mcpServers,
    mcpDisabled: formData.mcpDisabled,
  });

  // ── MCP form helpers ────────────────────────────────────────────────────

  const toggleGlobalMcpInherit = (name: string) => {
    setFormData((prev) => {
      const disabled = new Set(prev.mcpDisabled);
      if (disabled.has(name)) disabled.delete(name);
      else disabled.add(name);
      return { ...prev, mcpDisabled: [...disabled] };
    });
  };

  const handleMcpSave = (value: MCPServerFormValue) => {
    if (Object.prototype.hasOwnProperty.call(globalMcp, value.name)) {
      toast.error(
        `'${value.name}' is already a global server. ` +
          `Edit it in Settings → MCP, or pick a different name for the agent-private server.`
      );
      return;
    }
    setFormData((prev) => ({
      ...prev,
      mcpServers: { ...prev.mcpServers, [value.name]: value.config },
    }));
    setMcpDialog(null);
  };

  const handleMcpRemove = (name: string) => {
    setFormData((prev) => {
      const next = { ...prev.mcpServers };
      delete next[name];
      return { ...prev, mcpServers: next };
    });
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

  // ── CRUD ─────────────────────────────────────────────────────────────────
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: formData.id || formData.name.toLowerCase().replace(/\s+/g, "-"),
          ...buildAgentBody(),
        }),
      });
      if (res.ok) {
        toast.success("Agent created");
        setIsCreating(false);
        resetForm();
        reloadAgents();
      } else {
        const data = await res.json();
        toast.error("Failed to create agent", { description: data.error });
      }
    } catch {
      toast.error("Failed to create agent");
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgent) return;
    try {
      const res = await fetch(`${API_BASE}/api/agents/${selectedAgent.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAgentBody()),
      });
      if (res.ok) {
        const updated = (await res.json()) as Agent;
        setSelectedAgent(updated);
        toast.success("Agent updated");
        reloadAgents();
      } else {
        const data = await res.json();
        toast.error("Failed to update agent", { description: data.error });
      }
    } catch {
      toast.error("Failed to update agent");
    }
  };

  const handleDelete = async (id: string) => {
    setConfirmDelete(null);
    try {
      const res = await fetch(`${API_BASE}/api/agents/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Agent deleted");
        if (selectedAgent?.id === id) {
          setSelectedAgent(null);
          resetForm();
        }
        reloadAgents();
      } else {
        toast.error("Failed to delete agent");
      }
    } catch {
      toast.error("Failed to delete agent");
    }
  };

  const selectAgent = (agent: Agent) => {
    const provPresets =
      providers.find((p) => p.id === agent.model.provider)?.models ?? [];
    const matchedPreset = provPresets.some((m) => m.id === agent.model.model);
    setSelectedAgent(agent);
    setIsCreating(false);
    setIsCustomModel(!matchedPreset);
    setFormData({
      id: agent.id,
      name: agent.name,
      provider: agent.model.provider,
      model: agent.model.model,
      persona: agent.persona,
      tools: agent.tools,
      mcpServers: agent.mcpServers ?? {},
      mcpDisabled: agent.mcpDisabled ?? [],
    });
  };

  const resetForm = () => {
    const defaultProvider = providers[0]?.id ?? FALLBACK_FORM.provider;
    const defaultModel =
      providers.find((p) => p.id === defaultProvider)?.models[0]?.id ?? "";
    setFormData({
      ...FALLBACK_FORM,
      provider: defaultProvider,
      model: defaultModel,
    });
    setIsCustomModel(defaultModel === "");
  };

  const startCreate = () => {
    setSelectedAgent(null);
    setIsCreating(true);
    resetForm();
  };

  const showForm = selectedAgent || isCreating;

  // Select value: when in custom mode show CUSTOM_MODEL, otherwise the model id.
  // Empty string would disable the trigger's "selected" state, so guard against it.
  const modelSelectValue = isCustomModel
    ? CUSTOM_MODEL
    : formData.model || (presets[0]?.id ?? CUSTOM_MODEL);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <div>
            <h2 className="text-sm font-semibold">Agents</h2>
            <p className="text-xs text-muted-foreground">
              {agents.length} configured
            </p>
          </div>
          <Button size="sm" onClick={startCreate}>
            <Plus className="size-4" />
            New agent
          </Button>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <aside className="w-72 shrink-0 overflow-y-auto border-r p-4">
            <div className="space-y-2">
              {agents.length === 0 && (
                <p className="text-sm text-muted-foreground px-1">
                  No agents yet. Create your first one.
                </p>
              )}
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => selectAgent(agent)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                    selectedAgent?.id === agent.id
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:bg-accent/40"
                  )}
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Bot className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{agent.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {agent.model.provider}/{agent.model.model.split("/").pop()}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <div className="flex-1 overflow-y-auto p-6">
            {showForm ? (
              <form
                onSubmit={isCreating ? handleCreate : handleUpdate}
                className="mx-auto max-w-2xl"
              >
                <Card>
                  <CardHeader>
                    <CardTitle>
                      {isCreating ? "Create agent" : "Edit agent"}
                    </CardTitle>
                    <CardDescription>
                      {isCreating
                        ? "Configure a new agent's model, persona, and tools."
                        : "Update this agent's configuration."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <div className="grid gap-2">
                      <Label htmlFor="name">Name</Label>
                      <Input
                        id="name"
                        value={formData.name}
                        onChange={(e) =>
                          setFormData({ ...formData, name: e.target.value })
                        }
                        placeholder="My Agent"
                        required
                      />
                    </div>

                    {isCreating && (
                      <div className="grid gap-2">
                        <Label htmlFor="id">ID (optional)</Label>
                        <Input
                          id="id"
                          value={formData.id}
                          onChange={(e) =>
                            setFormData({ ...formData, id: e.target.value })
                          }
                          placeholder="my-agent (auto-generated from name)"
                        />
                      </div>
                    )}

                    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                      <div className="grid gap-2">
                        <Label htmlFor="provider">Provider</Label>
                        <Select
                          value={formData.provider}
                          onValueChange={onProviderChange}
                        >
                          <SelectTrigger id="provider">
                            <SelectValue placeholder="Select a provider" />
                          </SelectTrigger>
                          <SelectContent>
                            {providers.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="grid gap-2">
                        <Label htmlFor="model">Model</Label>
                        {presets.length > 0 ? (
                          <Select
                            value={modelSelectValue}
                            onValueChange={onModelSelect}
                          >
                            <SelectTrigger id="model">
                              <SelectValue placeholder="Select a model" />
                            </SelectTrigger>
                            <SelectContent>
                              {presets.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                  <div className="flex flex-col items-start">
                                    <span>{m.label}</span>
                                    {m.hint && (
                                      <span className="text-[10px] text-muted-foreground">
                                        {m.hint}
                                      </span>
                                    )}
                                  </div>
                                </SelectItem>
                              ))}
                              <SelectItem value={CUSTOM_MODEL}>
                                <span className="text-muted-foreground">
                                  Custom model id…
                                </span>
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        ) : null}
                        {(isCustomModel || presets.length === 0) && (
                          <Input
                            id={presets.length === 0 ? "model" : "model-custom"}
                            value={formData.model}
                            onChange={(e) =>
                              setFormData({ ...formData, model: e.target.value })
                            }
                            placeholder="Enter model id"
                            className="font-mono text-xs"
                            required
                          />
                        )}
                      </div>
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="persona">Persona</Label>
                      <Textarea
                        id="persona"
                        value={formData.persona}
                        onChange={(e) =>
                          setFormData({ ...formData, persona: e.target.value })
                        }
                        placeholder="You are a helpful AI assistant."
                        rows={4}
                      />
                    </div>

                    <ToolPicker
                      groups={toolsByToolset}
                      selected={formData.tools}
                      onToggle={toggleTool}
                    />

                    <McpSection
                      globalServers={globalMcp}
                      privateServers={formData.mcpServers}
                      disabled={formData.mcpDisabled}
                      onToggleInherit={toggleGlobalMcpInherit}
                      onAdd={() => setMcpDialog({ mode: "add" })}
                      onEdit={(name, cfg) =>
                        setMcpDialog({
                          mode: "edit",
                          initial: { name, config: cfg },
                        })
                      }
                      onRemove={handleMcpRemove}
                    />
                  </CardContent>
                </Card>

                <div className="mt-4 flex items-center justify-between">
                  <div>
                    {selectedAgent && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setConfirmDelete(selectedAgent.id)}
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </Button>
                    )}
                  </div>
                  <Button type="submit">
                    <Save className="size-4" />
                    {isCreating ? "Create" : "Save changes"}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
                    <Bot className="size-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Select an agent to edit, or create a new one.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete agent?</DialogTitle>
            <DialogDescription>
              This will permanently delete the agent <span className="font-mono">{confirmDelete}</span>. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && handleDelete(confirmDelete)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mcpDialog !== null}
        onOpenChange={(open) => !open && setMcpDialog(null)}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {mcpDialog?.mode === "edit"
                ? `Edit '${mcpDialog.initial.name}'`
                : "Add agent-private MCP server"}
            </DialogTitle>
            <DialogDescription>
              Private to this agent only. Names cannot collide with the
              global catalog in Settings → MCP.
            </DialogDescription>
          </DialogHeader>
          {mcpDialog && (
            <MCPServerForm
              initial={
                mcpDialog.mode === "edit" ? mcpDialog.initial : undefined
              }
              lockName={mcpDialog.mode === "edit"}
              reservedNames={[
                ...Object.keys(globalMcp),
                ...(mcpDialog.mode === "add"
                  ? Object.keys(formData.mcpServers)
                  : []),
              ]}
              onSubmit={handleMcpSave}
              onCancel={() => setMcpDialog(null)}
              onTest={handleMcpTest}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── MCP section in the agent editor ─────────────────────────────────────────
function McpSection({
  globalServers,
  privateServers,
  disabled,
  onToggleInherit,
  onAdd,
  onEdit,
  onRemove,
}: {
  globalServers: Record<string, MCPServerConfigDto>;
  privateServers: Record<string, MCPServerConfigDto>;
  disabled: string[];
  onToggleInherit: (name: string) => void;
  onAdd: () => void;
  onEdit: (name: string, cfg: MCPServerConfigDto) => void;
  onRemove: (name: string) => void;
}) {
  const globalEntries = Object.entries(globalServers);
  const privateEntries = Object.entries(privateServers);
  const disabledSet = new Set(disabled);
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <Boxes className="size-4 text-muted-foreground" />
        <Label className="m-0">MCP servers</Label>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            inherited from global catalog
          </span>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            edit catalog
            <ExternalLink className="size-3" />
          </Link>
        </div>
        {globalEntries.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No global servers configured. Add some in Settings → MCP, or
            define an agent-private server below.
          </p>
        ) : (
          <ul className="grid gap-1.5">
            {globalEntries.map(([name, cfg]) => {
              const inherited = !disabledSet.has(name);
              return (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => onToggleInherit(name)}
                    aria-pressed={inherited}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md border p-2.5 text-left transition-colors",
                      inherited
                        ? "border-primary/50 bg-primary/5"
                        : "border-border hover:bg-accent/40"
                    )}
                  >
                    <div
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        inherited
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background"
                      )}
                    >
                      {inherited && <Check className="size-3" strokeWidth={3} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs font-medium">
                        {name}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {cfg.command
                          ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
                          : cfg.url ?? ""}
                      </div>
                    </div>
                    {!inherited && (
                      <Badge variant="secondary" className="text-[10px]">
                        excluded
                      </Badge>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            agent-private servers
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onAdd}>
            <Plus className="size-3.5" />
            Add private
          </Button>
        </div>
        {privateEntries.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            None. Add one only when you need a server scoped to this agent
            (e.g., a Notion MCP only this agent should use).
          </p>
        ) : (
          <ul className="grid gap-1.5">
            {privateEntries.map(([name, cfg]) => (
              <li
                key={name}
                className="flex items-center gap-2 rounded-md border p-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs font-medium">
                    {name}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {cfg.command
                      ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
                      : cfg.url ?? ""}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onEdit(name, cfg)}
                  aria-label="Edit"
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(name)}
                  aria-label="Remove"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Tool picker ─────────────────────────────────────────────────────────────
function ToolPicker({
  groups,
  selected,
  onToggle,
}: {
  groups: [string, ToolInfo[]][];
  selected: string[];
  onToggle: (name: string) => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="grid gap-2">
        <Label>Tools</Label>
        <p className="text-sm text-muted-foreground">
          No tools registered on the server yet.
        </p>
      </div>
    );
  }
  const total = groups.reduce((acc, [, list]) => acc + list.length, 0);
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <Label>Tools</Label>
        <span className="text-[11px] text-muted-foreground">
          {selected.length} of {total} selected
        </span>
      </div>
      <div className="space-y-4">
        {groups.map(([toolset, list]) => {
          const selectedInGroup = list.filter((t) =>
            selected.includes(t.name)
          ).length;
          return (
            <div key={toolset}>
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {toolset}
                </span>
                {selectedInGroup > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    ({selectedInGroup}/{list.length})
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                {list.map((tool) => (
                  <ToolToggle
                    key={tool.name}
                    tool={tool}
                    checked={selected.includes(tool.name)}
                    onClick={() => onToggle(tool.name)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolToggle({
  tool,
  checked,
  onClick,
}: {
  tool: ToolInfo;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={checked}
      className={cn(
        "flex items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors",
        checked
          ? "border-primary/50 bg-primary/5"
          : "border-border hover:bg-accent/40"
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background"
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs font-medium">{tool.name}</div>
        <div className="line-clamp-2 text-[11px] text-muted-foreground">
          {tool.description}
        </div>
      </div>
    </button>
  );
}
