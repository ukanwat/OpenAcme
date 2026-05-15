"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Files, FolderUp, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { API_BASE } from "../lib/api";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { cn } from "../lib/utils";

interface AgentResource {
  relPath: string;
  size: number;
}

const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_AGENT = 200;

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * Resources panel for an agent. Lists files under
 * `<agentDir>/resources/`, supports upload (file or folder), delete,
 * and download. Pure presentational + fetcher — no parent state needed
 * beyond the agentId.
 */
export function AgentResourcesPanel({ agentId }: { agentId: string }) {
  const [resources, setResources] = useState<AgentResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/resources`
      );
      if (res.ok) {
        const data = (await res.json()) as { resources: AgentResource[] };
        setResources(data.resources ?? []);
      }
    } catch {
      // load failures surface via the page-level toast; silent here.
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (arr.length === 0) return;

      if (resources.length + arr.length > MAX_FILES_PER_AGENT) {
        toast.error(
          `Adding ${arr.length} files would exceed the ${MAX_FILES_PER_AGENT}-file cap.`
        );
        return;
      }

      let total = 0;
      for (const f of arr) {
        if (f.size > MAX_FILE_BYTES) {
          toast.error(`${f.name}: too large (max 1 MB)`);
          return;
        }
        total += f.size;
        if (total > MAX_REQUEST_BYTES) {
          toast.error("Upload would exceed 10 MB total");
          return;
        }
      }

      setUploading(true);
      try {
        const form = new FormData();
        for (const f of arr) {
          // webkitRelativePath is set when picked via a folder input or
          // dropped from a directory; otherwise fall back to the bare name.
          const fileWithPath = f as File & { webkitRelativePath?: string };
          const rel =
            fileWithPath.webkitRelativePath &&
            fileWithPath.webkitRelativePath.length > 0
              ? fileWithPath.webkitRelativePath
              : f.name;
          form.append(rel, f, f.name);
        }
        const res = await fetch(
          `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/resources`,
          { method: "POST", body: form }
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(data.error || res.statusText);
        }
        const data = (await res.json()) as { resources: AgentResource[] };
        setResources(data.resources ?? []);
        toast.success(`Uploaded ${arr.length} file${arr.length === 1 ? "" : "s"}`);
      } catch (err) {
        toast.error("Upload failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setUploading(false);
      }
    },
    [agentId, resources.length]
  );

  const removeResource = useCallback(
    async (relPath: string) => {
      try {
        const res = await fetch(
          `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/resources/${relPath
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
          { method: "DELETE" }
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(data.error || res.statusText);
        }
        setResources((prev) => prev.filter((r) => r.relPath !== relPath));
      } catch (err) {
        toast.error("Delete failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [agentId]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setDragOver(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setDragOver(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      setDragOver(false);
      void upload(e.dataTransfer.files);
    },
    [upload]
  );

  const downloadHref = (relPath: string) =>
    `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/resources/${relPath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;

  return (
    <div
      className={cn(
        "grid gap-3 transition-colors",
        dragOver && "outline outline-1 outline-plot-red outline-offset-4"
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Files className="size-4 text-ink-soft" />
          <Label className="m-0">
            Resources
            <span className="ml-2 font-normal text-ink-faint">
              files this agent can read
            </span>
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            onChange={(e) => {
              if (e.target.files) void upload(e.target.files);
              e.target.value = "";
            }}
          />
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
              if (e.target.files) void upload(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-4" />
            Upload files
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={uploading}
            onClick={() => folderInputRef.current?.click()}
          >
            <FolderUp className="size-4" />
            Upload folder
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
          Loading…
        </p>
      ) : resources.length === 0 ? (
        <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
          No resources. Drop files here or use the buttons above. They land
          under{" "}
          <span className="text-ink">{"<agent>/resources/"}</span> and become
          visible to the agent in its system prompt.
        </p>
      ) : (
        <ul className="border-y border-paper-rule font-mono text-[12px]">
          {resources.map((r) => (
            <li
              key={r.relPath}
              className="flex items-center gap-3 border-b border-paper-rule last:border-b-0 px-3 py-1.5 text-ink-soft tabular-nums"
            >
              <span className="min-w-0 flex-1 truncate text-ink">
                {r.relPath}
              </span>
              <span className="shrink-0 text-ink-faint">
                {formatBytes(r.size)}
              </span>
              <a
                href={downloadHref(r.relPath)}
                target="_blank"
                rel="noreferrer"
                className="text-ink-soft hover:text-plot-red"
                aria-label={`Download ${r.relPath}`}
              >
                <Download className="size-3.5" />
              </a>
              <button
                type="button"
                onClick={() => void removeResource(r.relPath)}
                className="text-ink-soft hover:text-plot-red"
                aria-label={`Delete ${r.relPath}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
