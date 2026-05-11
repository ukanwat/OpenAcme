"use client"

import * as React from "react"

import { cn } from "@/app/lib/utils"

// Skips animation on first mount — only ticks on actual changes.
export function TabularTick({
  value,
  className,
  ...rest
}: {
  value: string | number
} & React.HTMLAttributes<HTMLSpanElement>) {
  const mounted = React.useRef(false)
  const [tickKey, setTickKey] = React.useState(0)
  React.useEffect(() => {
    if (mounted.current) {
      setTickKey((k) => k + 1)
    } else {
      mounted.current = true
    }
  }, [value])
  return (
    <span
      className={cn("font-mono tabular-nums", className)}
      {...rest}
    >
      <span key={tickKey} className="inline-block tick">
        {value}
      </span>
    </span>
  )
}
