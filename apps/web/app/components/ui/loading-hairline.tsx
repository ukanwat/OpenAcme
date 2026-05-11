import * as React from "react"

import { cn } from "@/app/lib/utils"

export function LoadingHairline({
  className,
  inline = false,
  "aria-label": ariaLabel = "Loading",
}: {
  className?: string
  inline?: boolean
  "aria-label"?: string
}) {
  if (inline) {
    return (
      <span
        role="status"
        aria-label={ariaLabel}
        className={cn(
          "relative inline-block h-px w-8 overflow-hidden align-middle",
          className
        )}
      >
        <span aria-hidden className="loading-hairline" />
      </span>
    )
  }
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cn("pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden", className)}
    >
      <span aria-hidden className="loading-hairline" />
    </span>
  )
}
