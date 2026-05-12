import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/app/lib/utils"

/*
 * Lab/instrument badge — sharp, hairline-bordered, mono UPPERCASE label.
 * Use for status tags, IDs, and category labels. Pair color with text per
 * the no-color-only-state rule.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-none px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] whitespace-nowrap transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-plot-red [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-ink text-paper",
        secondary: "bg-paper-sunk text-ink-soft",
        signal: "bg-plot-red text-paper",
        // WAIT role — blocked / parked / paused. Recessed monochrome: one
        // tonal step + ink-faint hairline. Distinct from default (dark fill)
        // because the wait state should read as "lower energy than active."
        attention: "bg-paper-sunk text-ink border border-ink-faint",
        // LATER / ELSEWHERE role — scheduled-future, read-only awareness.
        // Even-more-recessive monochrome: ink-faint text on plain paper.
        elsewhere: "bg-paper text-ink-faint border border-paper-rule",
        // OK / healthy role — daemon up, agent online, MCP connected.
        // Calm filled monochrome; reads as "at rest, fine."
        healthy: "bg-paper text-ink border border-ink-faint",
        destructive: "bg-destructive text-paper",
        outline: "border border-paper-rule bg-transparent text-ink-soft",
        ghost: "bg-transparent text-ink-soft [a&]:hover:text-plot-red",
        link: "text-ink underline-offset-4 [a&]:hover:underline [a&]:hover:text-plot-red",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
