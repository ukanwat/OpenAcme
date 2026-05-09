"use client";

import { FileText, Image as ImageIcon, X, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/app/lib/utils";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentChipProps {
  kind: "image" | "file";
  mediaType: string;
  size: number;
  name: string;
  status?: "uploading" | "ready" | "error";
  error?: string;
  /** When true, render an `X` button that calls onRemove. */
  removable?: boolean;
  onRemove?: () => void;
  /** When set, the chip becomes a link target — used for the user bubble. */
  href?: string;
}

export function AttachmentChip({
  kind,
  mediaType,
  size,
  name,
  status,
  error,
  removable,
  onRemove,
  href,
}: AttachmentChipProps) {
  const Icon = kind === "image" ? ImageIcon : FileText;
  const inner = (
    <span className="flex items-center gap-1.5 min-w-0">
      {status === "uploading" ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : status === "error" ? (
        <AlertCircle className="size-3.5 shrink-0 text-destructive" />
      ) : (
        <Icon className="size-3.5 shrink-0 text-primary" />
      )}
      <span className="truncate text-[12px] font-medium">{name}</span>
      <span className="text-[11px] text-muted-foreground shrink-0">
        {formatSize(size)}
      </span>
    </span>
  );

  return (
    <span
      className={cn(
        "inline-flex max-w-[260px] items-center gap-1 rounded-md border bg-muted/50 px-2 py-1",
        status === "error" && "border-destructive/40 bg-destructive/5"
      )}
      title={error ?? `${name} (${mediaType})`}
    >
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 hover:underline"
        >
          {inner}
        </a>
      ) : (
        inner
      )}
      {removable && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove attachment"
          className="ml-0.5 rounded p-0.5 hover:bg-destructive/15 hover:text-destructive shrink-0"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
