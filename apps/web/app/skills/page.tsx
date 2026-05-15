"use client";

import { Suspense, useState, useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Search, Trash2, Upload } from "lucide-react";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
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
import { Skeleton } from "@/app/components/ui/skeleton";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { cn } from "@/app/lib/utils";

interface SkillIndexEntry {
  name: string;
  description: string;
  tags: string[];
}

interface SkillResource {
  relPath: string;
  size: number;
}

interface Skill {
  name: string;
  description: string;
  tags: string[];
  body: string;
  relatedSkills: string[];
  resources?: SkillResource[];
  dirPath?: string;
}

export default function SkillsPage() {
  return (
    <Suspense fallback={null}>
      <SkillsPageInner />
    </Suspense>
  );
}

function SkillsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlName = searchParams.get("name");
  const urlCreate = searchParams.get("create") === "1";

  const [skills, setSkills] = useState<SkillIndexEntry[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    tags: "",
    body: "",
  });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    loadSkills(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  // ?name=<name> selects a skill; ?create=1 opens the create form.
  useEffect(() => {
    if (urlCreate) {
      setIsCreating(true);
      setSelectedSkill(null);
      return;
    }
    if (urlName) {
      setIsCreating(false);
      loadSkillDetail(urlName);
      return;
    }
    setIsCreating(false);
    setSelectedSkill(null);
  }, [urlName, urlCreate]);

  const loadSkills = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/skills`, { signal });
      if (res.ok) {
        const data = await res.json();
        setSkills(data);
      } else {
        toast.error("Failed to load skills");
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load skills", { description: "Is the server running?" });
    } finally {
      setLoading(false);
    }
  };

  const loadSkillDetail = async (name: string) => {
    setIsCreating(false);
    try {
      const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}`);
      if (res.ok) {
        setSelectedSkill(await res.json());
      } else {
        toast.error("Failed to load skill details");
      }
    } catch {
      toast.error("Failed to load skill details");
    }
  };

  const createSkill = async () => {
    if (!formData.name.trim() || !formData.description.trim()) {
      toast.error("Name and description are required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim(),
          tags: formData.tags.split(",").map((t) => t.trim()).filter(Boolean),
          body: formData.body,
        }),
      });
      if (res.ok) {
        toast.success("Skill created");
        const createdName = formData.name.trim();
        setFormData({ name: "", description: "", tags: "", body: "" });
        loadSkills();
        router.push(`/skills?name=${encodeURIComponent(createdName)}`);
      } else {
        const data = await res.json();
        toast.error("Failed to create skill", { description: data.error });
      }
    } catch {
      toast.error("Failed to create skill");
    } finally {
      setSaving(false);
    }
  };

  const importFolder = async (files: FileList) => {
    if (files.length === 0) return;

    // Each File carries `webkitRelativePath` ("my-skill/SKILL.md", etc.).
    // Send as multipart with the relative path as the field name so the
    // server can reconstruct the directory structure.
    const form = new FormData();
    let hasSkillMd = false;
    for (const file of Array.from(files)) {
      const rel = file.webkitRelativePath || file.name;
      form.append(rel, file);
      const parts = rel.split("/");
      if (parts.at(-1) === "SKILL.md") hasSkillMd = true;
    }

    if (!hasSkillMd) {
      toast.error("Folder must contain a SKILL.md file");
      return;
    }

    setImporting(true);
    try {
      const res = await fetch(`${API_BASE}/api/skills/import`, {
        method: "POST",
        body: form,
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Imported skill '${data.name}'`);
        loadSkills();
        if (data.name) router.push(`/skills?name=${encodeURIComponent(data.name)}`);
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error("Import failed", { description: data.error });
      }
    } catch (e) {
      toast.error("Import failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setImporting(false);
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  };

  const deleteSkill = async (name: string) => {
    setConfirmDelete(null);
    try {
      const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Skill deleted");
        loadSkills();
        router.push("/skills");
      } else {
        toast.error("Failed to delete skill");
      }
    } catch {
      toast.error("Failed to delete skill");
    }
  };

  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [skills, searchQuery]);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    skills.forEach((s) => s.tags.forEach((t) => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [skills]);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-paper-rule px-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Skills
            </span>
            <span className="h-3 w-px bg-paper-rule" aria-hidden />
            <span className="font-mono text-[12px] tabular-nums text-ink-soft">
              {skills.length} loaded
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={folderInputRef}
              type="file"
              hidden
              // @ts-expect-error -- webkitdirectory + directory are non-standard
              // attributes used to pick a folder in Chromium-based browsers.
              webkitdirectory=""
              directory=""
              multiple
              onChange={(e) => {
                if (e.target.files) void importFolder(e.target.files);
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={importing}
              onClick={() => folderInputRef.current?.click()}
            >
              {importing ? (
                <LoadingHairline inline />
              ) : (
                <Upload className="size-4" />
              )}
              Import folder
            </Button>
            <Button size="sm" onClick={() => router.push("/skills?create=1")}>
              <Plus className="size-4" />
              New skill
            </Button>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <aside className="flex w-80 shrink-0 flex-col border-r border-paper-rule">
            <div className="border-b border-paper-rule px-4 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Index
            </div>
            <div className="border-b border-paper-rule p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search skills"
                  className="pl-8"
                />
              </div>
              {allTags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {allTags.slice(0, 8).map((tag) => (
                    <button
                      key={tag}
                      onClick={() =>
                        setSearchQuery((s) => (s === tag ? "" : tag))
                      }
                    >
                      <Badge
                        variant={searchQuery === tag ? "signal" : "outline"}
                        className="cursor-pointer"
                      >
                        {tag}
                      </Badge>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {loading && (
                <div className="space-y-2 p-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              )}

              {!loading && filteredSkills.length === 0 && (
                <div className="px-4 py-6 font-mono text-[12px] text-ink-faint">
                  {skills.length === 0
                    ? "No skills loaded."
                    : "No matches."}
                </div>
              )}

              {!loading &&
                filteredSkills.map((skill) => {
                  const isActive = selectedSkill?.name === skill.name;
                  return (
                    <button
                      key={skill.name}
                      onClick={() => router.push(`/skills?name=${encodeURIComponent(skill.name)}`)}
                      className={cn(
                        "group relative flex w-full flex-col items-start gap-0.5 border-b border-paper-rule px-4 py-2.5 text-left transition-colors",
                        isActive
                          ? "bg-paper-sunk text-ink"
                          : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
                      )}
                    >
                      <span
                        className={cn(
                          "absolute inset-y-0 left-0 w-[2px] bg-plot-red transition-opacity",
                          isActive ? "opacity-100" : "opacity-0"
                        )}
                        aria-hidden
                      />
                      <span className="truncate font-mono text-[13px] text-ink w-full">
                        {skill.name}
                      </span>
                      <span className="line-clamp-2 text-[12px] text-ink-faint">
                        {skill.description}
                      </span>
                    </button>
                  );
                })}
            </div>
          </aside>

          <div className="flex-1 overflow-y-auto p-6">
            {isCreating ? (
              <Card className="mx-auto max-w-3xl">
                <CardHeader>
                  <CardTitle>Create skill</CardTitle>
                  <CardDescription>
                    Skills are markdown documents agents can dynamically load.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="grid gap-2">
                    <Label htmlFor="skill-name">Name</Label>
                    <Input
                      id="skill-name"
                      value={formData.name}
                      onChange={(e) =>
                        setFormData({ ...formData, name: e.target.value })
                      }
                      placeholder="my-skill"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="skill-desc">Description</Label>
                    <Input
                      id="skill-desc"
                      value={formData.description}
                      onChange={(e) =>
                        setFormData({ ...formData, description: e.target.value })
                      }
                      placeholder="What this skill does"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="skill-tags">Tags (comma-separated)</Label>
                    <Input
                      id="skill-tags"
                      value={formData.tags}
                      onChange={(e) =>
                        setFormData({ ...formData, tags: e.target.value })
                      }
                      placeholder="automation, testing"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="skill-body">Instructions (Markdown)</Label>
                    <Textarea
                      id="skill-body"
                      value={formData.body}
                      onChange={(e) =>
                        setFormData({ ...formData, body: e.target.value })
                      }
                      placeholder="Detailed instructions for the agent…"
                      rows={14}
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" onClick={() => router.push("/skills")}>
                      Cancel
                    </Button>
                    <Button onClick={createSkill} disabled={saving}>
                      {saving && <LoadingHairline inline />}
                      Create skill
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : selectedSkill ? (
              <div className="mx-auto max-w-3xl space-y-4">
                <Card>
                  <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-xl">{selectedSkill.name}</CardTitle>
                      <CardDescription className="mt-1.5">
                        {selectedSkill.description}
                      </CardDescription>
                    </div>
                    <Button
                      variant="ghost-destructive"
                      size="sm"
                      onClick={() => setConfirmDelete(selectedSkill.name)}
                    >
                      <Trash2 className="size-4" />
                      Delete
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {selectedSkill.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedSkill.tags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {selectedSkill.relatedSkills.length > 0 && (
                      <div>
                        <Label className="mb-2 block">Related</Label>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedSkill.relatedSkills.map((name) => (
                            <Button
                              key={name}
                              variant="ghost"
                              size="xs"
                              onClick={() => router.push(`/skills?name=${encodeURIComponent(name)}`)}
                            >
                              {name}
                            </Button>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedSkill.resources && selectedSkill.resources.length > 0 && (
                      <div>
                        <Label className="mb-2 block">
                          Resources ({selectedSkill.resources.length})
                        </Label>
                        <ul className="border-y border-paper-rule font-mono text-[12px]">
                          {selectedSkill.resources.map((r) => (
                            <li
                              key={r.relPath}
                              className="flex justify-between gap-4 border-b border-paper-rule last:border-b-0 px-3 py-1 text-ink-soft tabular-nums"
                            >
                              <span className="truncate">{r.relPath}</span>
                              <span className="shrink-0 text-ink-faint">{r.size}B</span>
                            </li>
                          ))}
                        </ul>
                        {selectedSkill.dirPath && (
                          <p className="mt-2 font-mono text-[11px] text-ink-faint">
                            {selectedSkill.dirPath}
                          </p>
                        )}
                      </div>
                    )}

                    <div>
                      <Label className="mb-2 block">Instructions</Label>
                      <pre className="border border-paper-rule bg-paper-sunk p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink">
                        {selectedSkill.body || "(No instructions)"}
                      </pre>
                    </div>
                  </CardContent>
                </Card>
              </div>
            ) : skills.length === 0 ? (
              <EmptySkillsState onCreate={() => router.push("/skills?create=1")} />
            ) : (
              <NoSkillPicked />
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
            <DialogTitle>Delete skill?</DialogTitle>
            <DialogDescription>
              This will permanently delete <span className="font-mono">{confirmDelete}</span>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && deleteSkill(confirmDelete)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptySkillsState({ onCreate }: { onCreate: () => void }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setExpanded(true), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="mx-auto max-w-2xl">
      <SectionEyebrow meta="0 skills">No skills installed</SectionEyebrow>

      <div className="mt-6 border border-paper-rule paper-surface">
        {/* Index-entry form: name · description · tags. This is what
         * the agent's system prompt actually receives — the rest is
         * loaded on demand via the skill_view tool. */}
        <div className="border-b border-paper-rule px-4 py-3 section-enter">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-[13px] text-ink">
              triage-issue
            </span>
            <span className="meta-row">tags: triage, github</span>
          </div>
          <div className="mt-1 text-[13px] leading-snug text-ink-soft">
            Decide whether an incoming issue is a bug, feature request,
            or noise.
          </div>
        </div>

        {/* Expanded body — appears after a delay. The full markdown
         * content the agent loads when it calls skill_view. */}
        {expanded && (
          <div
            className="px-4 py-3 section-enter"
            style={{ animationDelay: "0ms" }}
          >
            <div className="label-faceplate mb-2">Loaded on demand</div>
            <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink m-0 border-0 p-0 bg-transparent">
{`# Triage issue

Read the body. If it's a bug, file under bugs/.
If it's a feature request, file under proposals/.
If it's noise, close with a polite note.

Always link to the relevant commit when possible.`}
            </pre>
          </div>
        )}
      </div>

      <p className="mt-5 text-[13px] leading-relaxed text-ink-soft">
        A skill is a markdown file with frontmatter. The index above is
        what agents see in their system prompt; the body loads only when
        the agent calls{" "}
        <code className="px-1 py-0.5 font-mono text-[12px] text-ink">
          skill_view
        </code>
        . Progressive disclosure keeps context small.
      </p>

      <div className="mt-5">
        <Button onClick={onCreate}>
          <Plus className="size-4" />
          Author your first skill
        </Button>
      </div>
    </div>
  );
}

function NoSkillPicked() {
  return (
    <div className="mx-auto max-w-2xl">
      <SectionEyebrow>Select a skill</SectionEyebrow>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
        Pick a row from the index on the left to view its full markdown
        body and edit frontmatter.
      </p>
    </div>
  );
}
