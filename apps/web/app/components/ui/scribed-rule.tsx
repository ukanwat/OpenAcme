import * as React from "react"

import { cn } from "@/app/lib/utils"

export function ScribedRule({
  className,
  delay,
  ...rest
}: {
  delay?: number
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className={cn("h-px w-full bg-paper-rule scribe-in", className)}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
      {...rest}
    />
  )
}
