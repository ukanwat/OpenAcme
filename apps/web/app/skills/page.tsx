"use client";

import { useState, useEffect, useMemo } from "react";
import { BookOpen, Plus, Search, Trash2, Loader2 } from "lucide-react";
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

interface Skill {
  name: string;
  description: string;
  tags: string[];
  body: string;
  relatedSkills: string[];
}

export default function SkillsPage() {
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
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    loadSkills(ctrl.signal);
    return () => ctrl.abort();
  }, []);

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
        setFormData({ name: "", description: "", tags: "", body: "" });
        setIsCreating(false);
        loadSkills();
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

  const deleteSkill = async (name: string) => {
    setConfirmDelete(null);
    try {
      const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Skill deleted");
        setSelectedSkill(null);
        loadSkills();
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

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <div>
            <h2 className="text-sm font-semibold">Skills</h2>
            <p className="text-xs text-muted-foreground">{skills.length} skills</p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setIsCreating(true);
              setSelectedSkill(null);
            }}
          >
            <Plus className="size-4" />
            New skill
          </Button>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <aside className="flex w-80 shrink-0 flex-col border-r">
            <div className="space-y-3 border-b p-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search skills…"
                  className="pl-8"
                />
              </div>
              {allTags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {allTags.slice(0, 8).map((tag) => (
                    <button
                      key={tag}
                      onClick={() =>
                        setSearchQuery((s) => (s === tag ? "" : tag))
                      }
                    >
                      <Badge
                        variant={searchQuery === tag ? "default" : "secondary"}
                        className="cursor-pointer"
                      >
                        {tag}
                      </Badge>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {loading && (
                <div className="space-y-2 p-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full bg-muted" />
                  ))}
                </div>
              )}

              {!loading && filteredSkills.length === 0 && (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {skills.length === 0
                    ? "No skills yet. Create one to get started."
                    : "No matching skills."}
                </div>
              )}

              {!loading &&
                filteredSkills.map((skill) => (
                  <button
                    key={skill.name}
                    onClick={() => loadSkillDetail(skill.name)}
                    className={cn(
                      "flex w-full flex-col items-start gap-1 rounded-md px-3 py-2 text-left transition-colors",
                      selectedSkill?.name === skill.name
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50"
                    )}
                  >
                    <span className="truncate text-sm font-medium w-full">
                      {skill.name}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {skill.description}
                    </span>
                  </button>
                ))}
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
                    <Button variant="outline" onClick={() => setIsCreating(false)}>
                      Cancel
                    </Button>
                    <Button onClick={createSkill} disabled={saving}>
                      {saving && <Loader2 className="size-4 animate-spin" />}
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
                      variant="outline"
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
                          <Badge key={tag} variant="secondary">
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
                              variant="outline"
                              size="xs"
                              onClick={() => loadSkillDetail(name)}
                            >
                              {name}
                            </Button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div>
                      <Label className="mb-2 block">Instructions</Label>
                      <pre className="rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">
                        {selectedSkill.body || "(No instructions)"}
                      </pre>
                    </div>
                  </CardContent>
                </Card>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
                    <BookOpen className="size-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Select a skill or create a new one.
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
