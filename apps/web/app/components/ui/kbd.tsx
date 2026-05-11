import * as React from "react"

import { cn } from "@/app/lib/utils"

export function Kbd({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center px-1.5 py-0.5",
        "font-mono text-[10.5px] leading-none uppercase tracking-[0.04em]",
        "border border-paper-rule bg-paper-sunk text-ink-soft",
        "rounded-none",
        className
      )}
      {...rest}
    >
      {children}
    </kbd>
  )
}
