"use client";

import { useState, useEffect, useRef, FormEvent } from "react";
import { Search, Download, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { API_BASE } from "../lib/api";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Badge } from "@/app/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import { Skeleton } from "@/app/components/ui/skeleton";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";

interface SkillMeta {
  name: string;
  description: string;
  source: "github" | "url" | "claude-marketplace";
  identifier: string;
  trustLevel: "trusted" | "community";
  tags: string[];
  repo?: string;
  path?: string;
}

type SourceFilter = "all" | "github" | "claude-marketplace";

export function BrowseTab({ onInstalled }: { onInstalled?: () => void }) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [results, setResults] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  // First mount: pull a default empty-query browse so the user sees
  // something immediately. Also re-fetch whenever the source filter
  // changes — without this the dropdown looks dead until the user
  // hits Search.
  useEffect(() => {
    void doSearch(query);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  async function doSearch(q: string) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setHasSearched(true);
    try {
      const res = await fetch(`${API_BASE}/api/skills/hub/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, source, limit: 50 }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error("Search failed", { description: err.error });
        setResults([]);
        return;
      }
      setResults(await res.json());
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Search failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void doSearch(query);
  }

  async function install(meta: SkillMeta) {
    const key = `${meta.source}:${meta.identifier}`;
    setInstalling((s) => new Set(s).add(key));
    try {
      const res = await fetch(`${API_BASE}/api/skills/hub/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identifier: meta.identifier,
          source: meta.source,
        }),
      });
      const body = await res.json();
      if (res.ok) {
        toast.success(`Installed '${body.name}'`);
        onInstalled?.();
      } else if (res.status === 409) {
        toast.message(`'${meta.name}' is already installed`);
      } else {
        toast.error("Install failed", { description: body.error });
      }
    } catch (e) {
      toast.error("Install failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setInstalling((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <form onSubmit={submit} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills (pdf, review, format…)"
            className="pl-8"
          />
        </div>
        <Select value={source} onValueChange={(v) => setSource(v as SourceFilter)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="github">GitHub</SelectItem>
            <SelectItem value="claude-marketplace">Claude marketplace</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={loading}>
          {loading ? <LoadingHairline inline /> : "Search"}
        </Button>
      </form>

      {loading && results.length === 0 && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {!loading && hasSearched && results.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-[13px] text-ink-soft">
              No matches. Try a broader query or add a tap in the{" "}
              <span className="font-mono">Sources</span> tab.
            </p>
          </CardContent>
        </Card>
      )}

      {results.map((r) => {
        const key = `${r.source}:${r.identifier}`;
        const isInstalling = installing.has(key);
        return (
          <Card key={key} className="paper-surface">
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <CardTitle className="font-mono text-[15px]">
                    {r.name}
                  </CardTitle>
                  <Badge variant={r.trustLevel === "trusted" ? "signal" : "outline"}>
                    {r.trustLevel === "trusted" && (
                      <ShieldCheck className="mr-1 size-3" />
                    )}
                    {r.trustLevel}
                  </Badge>
                  <Badge variant="outline">{r.source}</Badge>
                </div>
                <CardDescription className="mt-1 break-words">
                  {r.description || <span className="text-ink-faint">(no description)</span>}
                </CardDescription>
                <p className="mt-2 truncate font-mono text-[11px] text-ink-faint">
                  {r.identifier}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => void install(r)}
                disabled={isInstalling}
              >
                {isInstalling ? (
                  <LoadingHairline inline />
                ) : (
                  <Download className="size-3.5" />
                )}
                Install
              </Button>
            </CardHeader>
            {r.tags.length > 0 && (
              <CardContent className="pt-0">
                <div className="flex flex-wrap gap-1.5">
                  {r.tags.map((t) => (
                    <Badge key={t} variant="outline">
                      {t}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
