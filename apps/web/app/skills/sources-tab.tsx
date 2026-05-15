"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { API_BASE } from "../lib/api";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Badge } from "@/app/components/ui/badge";
import { Skeleton } from "@/app/components/ui/skeleton";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";

interface Tap {
  source: "github" | "claude-marketplace";
  repo: string;
  path: string;
  addedAt: string;
}

export function SourcesTab() {
  const [taps, setTaps] = useState<Tap[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<{
    source: "github" | "claude-marketplace";
    repo: string;
    path: string;
  }>({ source: "github", repo: "", path: "skills/" });

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/skills/hub/taps`);
      if (res.ok) {
        setTaps(await res.json());
      } else {
        toast.error("Failed to load taps");
      }
    } catch (e) {
      toast.error("Failed to load taps", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }

  async function add() {
    if (!form.repo.trim()) {
      toast.error("Repo is required (owner/repo)");
      return;
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(form.repo)) {
      toast.error("Repo must be in owner/repo format");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(`${API_BASE}/api/skills/hub/taps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: form.source,
          repo: form.repo.trim(),
          path: form.path.trim() || "skills/",
        }),
      });
      if (res.ok) {
        toast.success(`Added tap: ${form.repo}`);
        setDialogOpen(false);
        setForm({ source: "github", repo: "", path: "skills/" });
        void load();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error("Failed to add tap", { description: body.error });
      }
    } catch (e) {
      toast.error("Failed to add tap", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setAdding(false);
    }
  }

  async function remove(repo: string) {
    try {
      const res = await fetch(
        `${API_BASE}/api/skills/hub/taps/${encodeURIComponent(repo)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        toast.success(`Removed tap: ${repo}`);
        void load();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error("Failed to remove tap", { description: body.error });
      }
    } catch (e) {
      toast.error("Failed to remove tap", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-ink-soft">
          Taps are GitHub repos or Claude marketplace catalogs the hub
          searches when you browse and install skills.
        </p>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="size-3.5" />
          Add tap
        </Button>
      </div>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      )}

      {!loading && taps.length === 0 && (
        <p className="text-center font-mono text-[12px] text-ink-faint py-8">
          No taps. Add one to expand the catalog.
        </p>
      )}

      {!loading && (
        <ul className="border-y border-paper-rule font-mono text-[12px]">
          {taps.map((t) => (
            <li
              key={`${t.source}:${t.repo}`}
              className="flex items-center justify-between gap-3 border-b border-paper-rule last:border-b-0 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{t.source}</Badge>
                  <span className="truncate text-ink">{t.repo}</span>
                </div>
                <div className="mt-0.5 text-ink-faint">
                  path: {t.path}
                </div>
              </div>
              <Button
                variant="ghost-destructive"
                size="sm"
                onClick={() => void remove(t.repo)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add tap</DialogTitle>
            <DialogDescription>
              Point the hub at a GitHub repo or a Claude marketplace
              catalog. Searches across taps include this one going forward.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="grid gap-2">
              <Label>Source</Label>
              <Select
                value={form.source}
                onValueChange={(v) =>
                  setForm({ ...form, source: v as Tap["source"] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="github">GitHub repo</SelectItem>
                  <SelectItem value="claude-marketplace">
                    Claude marketplace
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tap-repo">Repo</Label>
              <Input
                id="tap-repo"
                value={form.repo}
                onChange={(e) => setForm({ ...form, repo: e.target.value })}
                placeholder="owner/repo"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tap-path">Path inside the repo</Label>
              <Input
                id="tap-path"
                value={form.path}
                onChange={(e) => setForm({ ...form, path: e.target.value })}
                placeholder="skills/"
              />
            </div>
          </DialogBody>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={add} disabled={adding}>
              {adding && <LoadingHairline inline />}
              Add tap
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
