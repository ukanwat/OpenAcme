import * as React from "react"

import { cn } from "@/app/lib/utils"

export function PromptGlyph({
  className,
}: {
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block select-none font-mono text-ink-faint leading-none",
        className
      )}
    >
      ›
    </span>
  )
}
