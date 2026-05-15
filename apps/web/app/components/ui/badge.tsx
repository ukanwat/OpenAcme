import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/app/lib/utils"

/*
 * Lab/instrument badge — sharp, hairline-bordered, mono UPPERCASE label.
 * Use for status tags, IDs, and category labels. Pair color with text per
 * the no-color-only-state rule.
 *
 * Badges do not carry leading status dots. The standalone status-indicator
 * primitive (DESIGN.md §5) — a 6px dot + mono label, used in empty-state
 * previews and equivalent surfaces — is a separate vocabulary and should
 * not be nested inside a badge.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-none px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] whitespace-nowrap transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-plot-red [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        // Mono-fill chips (default = bg-ink, secondary = paper-sunk) and
        // the outline / ghost / link variants use theme-flipping tokens
        // because the chip and text invert together cleanly across modes.
        default: "bg-ink text-paper",
        secondary: "bg-paper-sunk text-ink-soft",
        // Chromatic-fill chips pin their label to a fixed OKLCH literal
        // rather than text-paper / text-ink. The bg colors (plot-red,
        // signal-blue, signal-amber, destructive) don't flip much across
        // themes, so the label needs to stay at the right contrast in
        // both modes. Without pinning, text-paper renders dark in dark
        // mode and produces dark-text-on-red / dark-text-on-blue which
        // is unconventional and lower-contrast.
        // Light-on-chromatic (~98% L, slight warm tint to match paper):
        signal: "bg-plot-red text-[oklch(98%_0.004_75)]",
        working: "bg-signal-blue text-[oklch(98%_0.004_75)]",
        destructive: "bg-destructive text-[oklch(98%_0.004_75)]",
        // Dark-on-chromatic (amber is too light for white text):
        attention: "bg-signal-amber text-[oklch(22%_0.008_280)]",
        // LATER / ELSEWHERE role — recessive mono; text-color callers
        // carry signal-blue inline so this badge variant stays mono.
        elsewhere: "bg-paper text-ink-faint border border-paper-rule",
        // OK / healthy — 15% green tint over flipping bg + text-ink works
        // in both themes because the tint floats over flipping paper.
        healthy: "bg-signal-green/15 text-ink border border-signal-green/60",
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
