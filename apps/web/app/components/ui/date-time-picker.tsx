"use client";

import * as React from "react";
import { CalendarIcon, X } from "lucide-react";

import { cn } from "@/app/lib/utils";
import { Calendar } from "./calendar";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

const pad2 = (n: number) => String(n).padStart(2, "0");

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function displayLabel(d: Date): string {
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/*
 * Calendar popover + visible time input. Storage is ISO-Z; the picker runs in
 * the browser's local timezone and converts at the boundary.
 */
export function DateTimePicker({
  value,
  onChange,
  id,
  placeholder = "Pick a date",
  className,
}: {
  value: string | null;
  onChange: (iso: string | null) => void;
  id?: string;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);

  const current = React.useMemo(() => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [value]);

  const time = current ? fmtTime(current) : "09:00";

  const setFromParts = (date: Date | undefined, t: string) => {
    if (!date) {
      onChange(null);
      return;
    }
    const [hhStr, mmStr] = (t || "00:00").split(":");
    const hh = Number(hhStr) || 0;
    const mm = Number(mmStr) || 0;
    const merged = new Date(date);
    merged.setHours(hh, mm, 0, 0);
    onChange(merged.toISOString());
  };

  return (
    <div className={cn("flex gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            id={id}
            aria-label={current ? displayLabel(current) : placeholder}
            className={cn(
              "flex h-9 flex-1 items-center justify-between gap-2 border border-paper-rule bg-paper px-3 text-left text-sm outline-none transition-colors hover:bg-paper-sunk focus-visible:border-plot-red",
              !current && "text-ink-faint"
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <CalendarIcon className="size-3.5 shrink-0 text-ink-faint" />
              <span className="truncate">
                {current ? displayLabel(current) : placeholder}
              </span>
            </span>
            {current && (
              <span
                role="button"
                tabIndex={0}
                aria-label="Clear"
                title="Clear"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onChange(null);
                  }
                }}
                className="ml-1 inline-flex size-4 items-center justify-center text-ink-faint transition-colors hover:text-plot-red"
              >
                <X className="size-3" />
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0">
          <Calendar
            mode="single"
            selected={current ?? undefined}
            defaultMonth={current ?? undefined}
            onSelect={(d) => {
              setFromParts(d, time);
              if (d) setOpen(false);
            }}
            captionLayout="dropdown"
          />
          <div className="flex items-center gap-2 border-t border-paper-rule px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Time
            </span>
            <Input
              type="time"
              value={current ? fmtTime(current) : "09:00"}
              onChange={(e) => {
                const d = current ?? new Date();
                setFromParts(d, e.target.value);
              }}
              className="h-8 w-32"
            />
            <button
              type="button"
              onClick={() => {
                setFromParts(new Date(), fmtTime(new Date()));
                setOpen(false);
              }}
              className="ml-auto font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft transition-colors hover:text-plot-red focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red"
            >
              Now
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export { fmtDate, fmtTime };
