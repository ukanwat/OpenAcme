import * as React from "react"

import { cn } from "@/app/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-none border border-paper-rule bg-paper px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-plot-red disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
