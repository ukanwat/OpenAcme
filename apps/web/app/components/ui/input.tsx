import * as React from "react"

import { cn } from "@/app/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-none border border-paper-rule bg-paper px-3 py-1 text-sm text-ink outline-none transition-colors selection:bg-plot-red selection:text-paper file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink placeholder:text-ink-faint disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-plot-red",
        "aria-invalid:border-destructive aria-invalid:text-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
