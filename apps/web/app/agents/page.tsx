"use client";

import { Suspense, useState, useEffect, useMemo } from "react";
import {
  Bot,
  Plus,
  Trash2,
  Save,
  Check,
  Pencil,
  Boxes,
  ExternalLink,
  BookOpen,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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
} from "@/app/components/ui/card";
import {
  Dialog,
  DialogBody,
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
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { TabularTick } from "@/app/components/ui/tabular-tick";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import { cn } from "@/app/lib/utils";
import { Markdown } from "@/app/components/Markdown";
import { AgentResourcesPanel } from "@/app/components/AgentResourcesPanel";

interface Agent {
  id: string;
  name: string;
  role: string;
  model: { provider: string; model: string };
  persona: string;
  tools: string[];
  skills: string[];
  mcpServers?: Record<string, MCPServerConfigDto>;
  mcpDisabled?: string[];
  memoryCharLimit?: number;
}

interface SkillIndexEntry {
  name: string;
  description: string;
  tags?: string[];
}

interface FormState {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  persona: string;
  tools: string[];
  skills: string[];
  memoryCharLimit: number;
  mcpServers: Record<string, MCPServerConfigDto>;
  mcpDisabled: string[];
}

const CUSTOM_MODEL = "__custom__";
const DEFAULT_MEMORY_CHAR_LIMIT = 2200;

const FALLBACK_FORM: FormState = {
  id: "",
  name: "",
  role: "",
  provider: "openrouter",
  model: "",
  persona: "You are a helpful AI assistant.",
  tools: [],
  skills: [],
  memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
  mcpServers: {},
  mcpDisabled: [],
};

export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentsPageInner />
    </Suspense>
  );
}

function AgentsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlId = searchParams.get("id");
  const urlCreate = searchParams.get("create") === "1";

  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [globalMcp, setGlobalMcp] = useState<Record<string, MCPServerConfigDto>>({});
  const [allSkills, setAllSkills] = useState<SkillIndexEntry[]>([]);

  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
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
      const [agentsRes, toolsRes, providersRes, mcpRes, skillsRes] =
        await Promise.all([
          fetch(`${API_BASE}/api/agents`, { signal }),
          fetch(`${API_BASE}/api/tools`, { signal }),
          fetch(`${API_BASE}/api/models`, { signal }),
          fetch(`${API_BASE}/api/mcp/global`, { signal }),
          fetch(`${API_BASE}/api/skills`, { signal }),
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
      if (skillsRes.ok) {
        setAllSkills((await skillsRes.json()) as SkillIndexEntry[]);
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
      // System tools are always on for every agent — hide from the picker.
      if (t.system) continue;
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
    role: formData.role,
    model: { provider: formData.provider, model: formData.model },
    persona: formData.persona,
    tools: formData.tools,
    skills: formData.skills,
    memoryCharLimit: formData.memoryCharLimit,
    mcpServers: formData.mcpServers,
    mcpDisabled: formData.mcpDisabled,
  });

  const toggleSkill = (name: string) => {
    setFormData((prev) => ({
      ...prev,
      skills: prev.skills.includes(name)
        ? prev.skills.filter((s) => s !== name)
        : [...prev.skills, name],
    }));
  };

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
        const created = (await res.json()) as Agent;
        toast.success("Agent created");
        await reloadAgents();
        router.push(`/agents?id=${encodeURIComponent(created.id)}`);
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
        setIsEditing(false);
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

  const cancelEdit = () => {
    if (!selectedAgent) return;
    setIsEditing(false);
    // Restore form to the saved agent's state so re-opening the editor
    // doesn't surface in-progress edits the user said "cancel" to.
    const provPresets =
      providers.find((p) => p.id === selectedAgent.model.provider)?.models ?? [];
    const matchedPreset = provPresets.some(
      (m) => m.id === selectedAgent.model.model
    );
    setIsCustomModel(!matchedPreset);
    setFormData({
      id: selectedAgent.id,
      name: selectedAgent.name,
      role: selectedAgent.role ?? "",
      provider: selectedAgent.model.provider,
      model: selectedAgent.model.model,
      persona: selectedAgent.persona,
      tools: selectedAgent.tools,
      skills: selectedAgent.skills ?? [],
      memoryCharLimit: selectedAgent.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT,
      mcpServers: selectedAgent.mcpServers ?? {},
      mcpDisabled: selectedAgent.mcpDisabled ?? [],
    });
  };

  const handleDelete = async (id: string) => {
    setConfirmDelete(null);
    try {
      const res = await fetch(`${API_BASE}/api/agents/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Agent deleted");
        await reloadAgents();
        if (selectedAgent?.id === id) {
          router.push("/agents");
        }
      } else {
        toast.error("Failed to delete agent");
      }
    } catch {
      toast.error("Failed to delete agent");
    }
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

  // URL → selection state. ?id=<id> selects an agent; ?create=1 starts create.
  useEffect(() => {
    if (urlCreate) {
      setSelectedAgent(null);
      setIsCreating(true);
      setIsEditing(false);
      const defaultProvider = providers[0]?.id ?? FALLBACK_FORM.provider;
      const defaultModel =
        providers.find((p) => p.id === defaultProvider)?.models[0]?.id ?? "";
      setFormData({
        ...FALLBACK_FORM,
        provider: defaultProvider,
        model: defaultModel,
      });
      setIsCustomModel(defaultModel === "");
      return;
    }
    if (urlId) {
      const found = agents.find((a) => a.id === urlId);
      if (found) {
        const provPresets =
          providers.find((p) => p.id === found.model.provider)?.models ?? [];
        const matchedPreset = provPresets.some(
          (m) => m.id === found.model.model
        );
        setSelectedAgent(found);
        setIsCreating(false);
        // View-first: don't auto-open into edit mode. The user clicks the
        // "Edit" button when they want to change something.
        setIsEditing(false);
        setIsCustomModel(!matchedPreset);
        setFormData({
          id: found.id,
          name: found.name,
          role: found.role ?? "",
          provider: found.model.provider,
          model: found.model.model,
          persona: found.persona,
          tools: found.tools,
          skills: found.skills ?? [],
          memoryCharLimit: found.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT,
          mcpServers: found.mcpServers ?? {},
          mcpDisabled: found.mcpDisabled ?? [],
        });
      } else if (agents.length > 0) {
        router.replace("/agents");
      }
      return;
    }
    setSelectedAgent(null);
    setIsCreating(false);
    setIsEditing(false);
  }, [urlId, urlCreate, agents, providers, router]);

  const selectAgent = (agent: Agent) =>
    router.push(`/agents?id=${encodeURIComponent(agent.id)}`);
  const startCreate = () => router.push("/agents?create=1");

  // View vs edit: existing agents open in a read-only detail view; the
  // user clicks "Edit" to switch into the form. Creating an agent goes
  // straight to the form (there's nothing to view yet).
  const showForm = isCreating || (selectedAgent !== null && isEditing);
  const showView = selectedAgent !== null && !isEditing && !isCreating;

  // Select value: when in custom mode show CUSTOM_MODEL, otherwise the model id.
  // Empty string would disable the trigger's "selected" state, so guard against it.
  const modelSelectValue = isCustomModel
    ? CUSTOM_MODEL
    : formData.model || (presets[0]?.id ?? CUSTOM_MODEL);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-paper-rule px-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Agents
            </span>
            <span className="h-3 w-px bg-paper-rule" aria-hidden />
            <span className="font-mono text-[12px] text-ink-soft">
              <TabularTick value={agents.length} /> configured
            </span>
          </div>
          <Button size="sm" onClick={startCreate}>
            <Plus className="size-4" />
            New agent
          </Button>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <aside className="w-72 shrink-0 overflow-y-auto border-r border-paper-rule">
            <div className="border-b border-paper-rule px-4 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Roster
            </div>
            {agents.length === 0 && (
              <p className="px-4 py-4 font-mono text-[12px] text-ink-faint">
                No agents configured.
              </p>
            )}
            {agents.map((agent) => {
              const isActive = selectedAgent?.id === agent.id;
              return (
                <button
                  key={agent.id}
                  onClick={() => selectAgent(agent)}
                  className={cn(
                    "group relative flex w-full items-start gap-3 border-b border-paper-rule px-4 py-3 text-left transition-colors",
                    isActive
                      ? "bg-paper-sunk text-ink"
                      : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
                  )}
                >
                  <ActiveMarker active={isActive} />
                  <Bot className="size-4 shrink-0 mt-0.5 text-ink-soft" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">
                      {agent.name}
                    </div>
                    {agent.role ? (
                      <div
                        className="truncate text-[11px] text-ink-faint"
                        title={agent.role}
                      >
                        {agent.role}
                      </div>
                    ) : (
                      <div
                        className="truncate font-mono text-[11px] tabular-nums text-ink-faint"
                        title={`${agent.model.provider}/${agent.model.model}`}
                      >
                        {agent.model.provider}/{agent.model.model}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </aside>

          <div className="flex-1 overflow-y-auto p-6">
            {showView && selectedAgent ? (
              <AgentDetail
                agent={selectedAgent}
                globalServers={globalMcp}
                allSkills={allSkills}
                onEdit={() => setIsEditing(true)}
                onDelete={() => setConfirmDelete(selectedAgent.id)}
              />
            ) : showForm ? (
              <form
                onSubmit={isCreating ? handleCreate : handleUpdate}
                className="mx-auto max-w-2xl"
              >
                <Card>
                  <CardHeader>
                    <CardTitle>
                      {isCreating ? "Create agent" : "Edit agent"}
                    </CardTitle>
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
                      <Label htmlFor="role">
                        Role
                        <span className="ml-2 font-normal text-ink-faint">
                          visible to other agents
                        </span>
                      </Label>
                      <Textarea
                        id="role"
                        value={formData.role}
                        onChange={(e) =>
                          setFormData({ ...formData, role: e.target.value })
                        }
                        placeholder="Owns X. Good for Y. Redirects Z to @other-agent."
                        rows={3}
                      />
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

                    <SkillsPicker
                      all={allSkills}
                      selected={formData.skills}
                      onToggle={toggleSkill}
                    />

                    <div className="grid gap-2">
                      <Label htmlFor="memory-char-limit">
                        Memory char limit
                        <span className="ml-2 font-normal text-ink-faint">
                          write-cap on MEMORY.md
                        </span>
                      </Label>
                      <Input
                        id="memory-char-limit"
                        type="number"
                        min={500}
                        max={50000}
                        step={100}
                        value={formData.memoryCharLimit}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            memoryCharLimit:
                              Number(e.target.value) || DEFAULT_MEMORY_CHAR_LIMIT,
                          })
                        }
                        className="font-mono text-xs max-w-[12rem]"
                      />
                    </div>

                    {selectedAgent && (
                      <AgentResourcesPanel agentId={selectedAgent.id} />
                    )}
                  </CardContent>
                </Card>

                <div className="mt-4 flex items-center justify-between">
                  <div>
                    {selectedAgent && (
                      <Button
                        type="button"
                        variant="ghost-destructive"
                        size="sm"
                        onClick={() => setConfirmDelete(selectedAgent.id)}
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedAgent && isEditing && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={cancelEdit}
                      >
                        Cancel
                      </Button>
                    )}
                    <Button type="submit">
                      <Save className="size-4" />
                      {isCreating ? "Create" : "Save changes"}
                    </Button>
                  </div>
                </div>
              </form>
            ) : agents.length === 0 ? (
              <EmptyWorkforceState onCreate={startCreate} />
            ) : (
              <NoAgentPicked />
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
            <DialogBody>
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
            </DialogBody>
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
    <div className="grid gap-5">
      <div className="flex items-center gap-2">
        <Boxes className="size-4 text-ink-soft" />
        <Label className="m-0">MCP servers</Label>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Inherited from global catalog
          </span>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft hover:text-plot-red"
          >
            Edit catalog
            <ExternalLink className="size-3" />
          </Link>
        </div>
        {globalEntries.length === 0 ? (
          <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
            No global servers configured. Add some in Settings → MCP, or
            define an agent-private server below.
          </p>
        ) : (
          <ul className="grid">
            {globalEntries.map(([name, cfg], idx) => {
              const inherited = !disabledSet.has(name);
              return (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => onToggleInherit(name)}
                    aria-pressed={inherited}
                    className={cn(
                      "group relative flex w-full items-center gap-3 border-paper-rule px-3 py-2 text-left transition-colors",
                      idx === 0 ? "border-t border-b" : "border-b",
                      inherited ? "bg-paper" : "bg-paper-sunk"
                    )}
                  >
                    <ActiveMarker active={inherited} />
                    <div
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center border",
                        inherited
                          ? "border-plot-red bg-plot-red text-paper"
                          : "border-paper-rule bg-paper"
                      )}
                    >
                      {inherited && <Check className="size-3" strokeWidth={3} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12px] text-ink">
                        {name}
                      </div>
                      <div className="truncate font-mono text-[11px] text-ink-faint">
                        {cfg.command
                          ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
                          : cfg.url ?? ""}
                      </div>
                    </div>
                    {!inherited && (
                      <Badge variant="outline">Excluded</Badge>
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
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Agent-private servers
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onAdd}>
            <Plus className="size-3.5" />
            Add private
          </Button>
        </div>
        {privateEntries.length === 0 ? (
          <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
            None. Add one only when you need a server scoped to this agent
            (e.g., a Notion MCP only this agent should use).
          </p>
        ) : (
          <ul className="grid">
            {privateEntries.map(([name, cfg], idx) => (
              <li
                key={name}
                className={cn(
                  "flex items-center gap-2 border-paper-rule px-3 py-2",
                  idx === 0 ? "border-t border-b" : "border-b"
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px] text-ink">
                    {name}
                  </div>
                  <div className="truncate font-mono text-[11px] text-ink-faint">
                    {cfg.command
                      ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
                      : cfg.url ?? ""}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onEdit(name, cfg)}
                  aria-label="Edit"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onRemove(name)}
                  aria-label="Remove"
                >
                  <Trash2 className="size-3.5" />
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
        <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
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
        <span className="font-mono text-[11px] tabular-nums text-ink-soft">
          {selected.length} / {total}
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
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  {toolset}
                </span>
                {selectedInGroup > 0 && (
                  <span className="font-mono text-[10px] tabular-nums text-ink-faint">
                    ({selectedInGroup}/{list.length})
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 gap-px md:grid-cols-2">
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
        "group relative flex items-start gap-3 border border-paper-rule px-3 py-2 text-left transition-colors",
        checked
          ? "bg-paper text-ink"
          : "bg-paper-sunk text-ink-soft hover:bg-paper hover:text-ink"
      )}
    >
      <ActiveMarker active={checked} />
      <div
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors",
          checked
            ? "border-plot-red bg-plot-red text-paper"
            : "border-paper-rule bg-paper"
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px] text-ink">{tool.name}</div>
        <div className="line-clamp-2 text-[11px] text-ink-faint">
          {tool.description}
        </div>
      </div>
    </button>
  );
}

function EmptyWorkforceState({ onCreate }: { onCreate: () => void }) {
  const rowDelay = (i: number) => 80 + i * 120;
  return (
    <div className="mx-auto max-w-2xl">
      <SectionEyebrow meta="0 agents">The workforce is empty</SectionEyebrow>

      <div className="mt-6 border border-dashed border-paper-rule paper-surface opacity-80">
        {/* Faux dossier — visual demonstration of an AGENT.md. Every row
         * is real mono with real metadata shape so the operator reads
         * the format off the page, not off external docs. */}
        <div
          className="border-b border-paper-rule px-4 py-3"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: `${rowDelay(0)}ms`,
          }}
        >
          <div className="label-faceplate mb-2 text-ink-faint">Preview</div>
          <div className="font-mono text-[12px] uppercase tracking-[0.06em] text-ink">
            example-agent
          </div>
          <div className="mt-1 meta-row">your agent · not yet created</div>
        </div>

        <div
          className="border-b border-paper-rule px-4 py-3 meta-row"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: `${rowDelay(1)}ms`,
          }}
        >
          <span className="text-ink-faint">model · </span>
          <span className="text-ink">anthropic/claude-sonnet-4-20250514</span>
        </div>

        <div
          className="border-b border-paper-rule px-4 py-3"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: `${rowDelay(2)}ms`,
          }}
        >
          <div className="label-faceplate mb-1">Persona</div>
          <div className="text-[13px] leading-snug text-ink-soft">
            A short paragraph describing what this coworker does, the tone
            they take, and what they shouldn&apos;t touch.
          </div>
        </div>

        <div
          className="border-b border-paper-rule px-4 py-3 meta-row flex items-center gap-4"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: `${rowDelay(3)}ms`,
          }}
        >
          <span>
            <span className="text-ink-faint">tools · </span>
            <span className="text-ink">12</span>
          </span>
          <span>
            <span className="text-ink-faint">mcp · </span>
            <span className="text-ink">3</span>
          </span>
          <span>
            <span className="text-ink-faint">skills · </span>
            <span className="text-ink">2</span>
          </span>
        </div>

        <div
          className="px-4 py-3 flex items-center gap-2"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: `${rowDelay(4)}ms`,
          }}
        >
          <span aria-hidden className="status-dot bg-ink" />
          <span className="label-faceplate">Ready</span>
        </div>
      </div>

      {/* Teaching caption — instrument-register, not marketing. Tells the
       * operator where files live in one sentence. */}
      <div
        className="mt-5 text-[13px] leading-relaxed text-ink-soft"
        style={{
          animation: "section-enter 320ms var(--ease-out-quart) both",
          animationDelay: `${rowDelay(5)}ms`,
        }}
      >
        This is the shape of an agent. Yours will live at{" "}
        <code className="px-1 py-0.5 font-mono text-[12px] text-ink">
          ~/.openacme/agents/&lt;id&gt;/AGENT.md
        </code>
        {" "}— YAML frontmatter for model, tools, and MCP servers, plus
        prose for the persona.
      </div>

      <div
        className="mt-5"
        style={{
          animation: "section-enter 320ms var(--ease-out-quart) both",
          animationDelay: `${rowDelay(6)}ms`,
        }}
      >
        <Button onClick={onCreate}>
          <Plus className="size-4" />
          Create your first agent
        </Button>
      </div>
    </div>
  );
}

function NoAgentPicked() {
  return (
    <div className="mx-auto max-w-2xl">
      <SectionEyebrow>Select an agent</SectionEyebrow>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
        Pick a row from the roster on the left to view its model, persona,
        tools, and resources.
      </p>
    </div>
  );
}

// ─── Read-only detail view ───────────────────────────────────────────────────
function AgentDetail({
  agent,
  globalServers,
  allSkills,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  globalServers: Record<string, MCPServerConfigDto>;
  allSkills: SkillIndexEntry[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const disabledSet = new Set(agent.mcpDisabled ?? []);
  const privateServers = Object.entries(agent.mcpServers ?? {});
  const inheritedServers = Object.entries(globalServers).filter(
    ([name]) => !disabledSet.has(name)
  );
  const skillEntries = (agent.skills ?? [])
    .map((name) => allSkills.find((s) => s.name === name) ?? { name, description: "" })
    .filter(Boolean);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="text-xl">{agent.name}</CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                {agent.id}
              </span>
              <span className="text-ink-faint">·</span>
              <span className="font-mono text-[11px] tabular-nums text-ink-soft">
                {agent.model.provider}/{agent.model.model}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" onClick={onEdit}>
              <Pencil className="size-4" />
              Edit
            </Button>
            <Button
              variant="ghost-destructive"
              size="sm"
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {agent.role && (
            <div>
              <Label className="mb-1.5 block">
                Role
                <span className="ml-2 font-normal text-ink-faint">
                  visible to other agents
                </span>
              </Label>
              <p className="text-[13px] leading-relaxed text-ink-soft">
                {agent.role}
              </p>
            </div>
          )}

          <div>
            <Label className="mb-1.5 block">Persona</Label>
            <div className="border border-paper-rule bg-paper-sunk px-4 py-3 text-[13px] leading-relaxed text-ink">
              <Markdown>{agent.persona}</Markdown>
            </div>
          </div>

          <div>
            <Label className="mb-1.5 block">
              Tools
              <span className="ml-2 font-normal text-ink-faint">
                {agent.tools.length} configurable
              </span>
            </Label>
            {agent.tools.length === 0 ? (
              <p className="font-mono text-[12px] text-ink-faint">
                None.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {agent.tools.map((t) => (
                  <Badge key={t} variant="outline" className="font-mono text-[11px]">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {skillEntries.length > 0 && (
            <div>
              <Label className="mb-1.5 block flex items-center gap-2">
                <BookOpen className="size-3.5 text-ink-soft" />
                Skills
                <span className="font-normal text-ink-faint">
                  {skillEntries.length} enabled
                </span>
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {skillEntries.map((s) => (
                  <Badge key={s.name} variant="outline" className="font-mono text-[11px]">
                    {s.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label className="mb-1.5 block flex items-center gap-2">
              <Boxes className="size-3.5 text-ink-soft" />
              MCP servers
            </Label>
            {inheritedServers.length === 0 && privateServers.length === 0 ? (
              <p className="font-mono text-[12px] text-ink-faint">
                None.
              </p>
            ) : (
              <ul className="border-y border-paper-rule">
                {inheritedServers.map(([name, cfg]) => (
                  <li
                    key={`g-${name}`}
                    className="flex items-center gap-3 border-b border-paper-rule last:border-b-0 px-3 py-1.5"
                  >
                    <Badge variant="outline" className="font-mono text-[10px]">
                      inherited
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                      {name}
                    </span>
                    <span className="shrink-0 truncate font-mono text-[11px] text-ink-faint max-w-[40%]">
                      {cfg.command
                        ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
                        : cfg.url ?? ""}
                    </span>
                  </li>
                ))}
                {privateServers.map(([name, cfg]) => (
                  <li
                    key={`p-${name}`}
                    className="flex items-center gap-3 border-b border-paper-rule last:border-b-0 px-3 py-1.5"
                  >
                    <Badge variant="outline" className="font-mono text-[10px]">
                      private
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                      {name}
                    </span>
                    <span className="shrink-0 truncate font-mono text-[11px] text-ink-faint max-w-[40%]">
                      {cfg.command
                        ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
                        : cfg.url ?? ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <AgentResourcesPanel agentId={agent.id} />
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Skills picker (form) ─────────────────────────────────────────────────────
function SkillsPicker({
  all,
  selected,
  onToggle,
}: {
  all: SkillIndexEntry[];
  selected: string[];
  onToggle: (name: string) => void;
}) {
  if (all.length === 0) {
    return (
      <div className="grid gap-2">
        <Label className="flex items-center gap-2">
          <BookOpen className="size-3.5 text-ink-soft" />
          Skills
        </Label>
        <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
          No skills installed.{" "}
          <Link href="/skills" className="text-plot-red hover:underline">
            Add some
          </Link>{" "}
          and they&apos;ll appear here.
        </p>
      </div>
    );
  }
  // Selected empty == inherit-all. Surface that explicitly so the picker
  // doesn't look broken when the agent's set is "unconfigured" but
  // every skill still applies.
  const inheritAll = selected.length === 0;
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2">
          <BookOpen className="size-3.5 text-ink-soft" />
          Skills
        </Label>
        <span className="font-mono text-[11px] tabular-nums text-ink-soft">
          {inheritAll ? `all (${all.length})` : `${selected.length} / ${all.length}`}
        </span>
      </div>
      {inheritAll && (
        <p className="font-mono text-[11px] text-ink-faint">
          Empty selection means the agent sees every installed skill.
          Pick one or more to scope it down.
        </p>
      )}
      <div className="grid grid-cols-1 gap-px md:grid-cols-2">
        {all.map((skill) => {
          const checked = selected.includes(skill.name);
          return (
            <button
              key={skill.name}
              type="button"
              onClick={() => onToggle(skill.name)}
              aria-pressed={checked}
              className={cn(
                "group relative flex items-start gap-3 border border-paper-rule px-3 py-2 text-left transition-colors",
                checked
                  ? "bg-paper text-ink"
                  : "bg-paper-sunk text-ink-soft hover:bg-paper hover:text-ink"
              )}
            >
              <ActiveMarker active={checked} />
              <div
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors",
                  checked
                    ? "border-plot-red bg-plot-red text-paper"
                    : "border-paper-rule bg-paper"
                )}
              >
                {checked && <Check className="size-3" strokeWidth={3} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12px] text-ink">
                  {skill.name}
                </div>
                <div className="line-clamp-2 text-[11px] text-ink-faint">
                  {skill.description}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
