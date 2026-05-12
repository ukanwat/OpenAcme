"use client"

import * as React from "react"

import { cn } from "@/app/lib/utils"

export function JargonChip({
  term,
  children,
  className,
  explanation,
}: {
  term: string
  children?: React.ReactNode
  className?: string
  explanation: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLSpanElement>(null)

  React.useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("mousedown", onDocClick)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("mousedown", onDocClick)
    }
  }, [open])

  return (
    <span
      ref={ref}
      className={cn("relative inline-flex items-baseline", className)}
    >
      {children}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Explain: ${term}`}
        className={cn(
          "ml-1 inline-flex items-center justify-center",
          "h-4 min-w-4 px-1 align-baseline",
          "font-mono text-[10px] leading-none uppercase tracking-[0.04em]",
          "border border-paper-rule bg-paper text-ink-soft",
          "transition-colors duration-[180ms] ease-out",
          "hover:bg-paper-sunk hover:text-ink",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-plot-red focus-visible:ring-offset-1"
        )}
      >
        ?
      </button>
      {open && (
        <span
          role="note"
          className={cn(
            "absolute left-0 top-full z-20 mt-1 w-80 max-w-[min(20rem,calc(100vw-2rem))]",
            "border border-paper-rule bg-paper p-3 text-left",
            "section-enter"
          )}
        >
          <span className="label-faceplate block mb-1.5 text-ink-soft">
            {term}
          </span>
          <span className="block text-[13px] leading-snug text-ink-soft">
            {explanation}
          </span>
        </span>
      )}
    </span>
  )
}
