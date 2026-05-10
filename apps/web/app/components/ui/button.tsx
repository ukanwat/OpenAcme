import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/app/lib/utils"

/*
 * Lab/instrument variants — sharp corners, no shadow, plot-red focus.
 *  - default: ink fill (primary). The dominant action on a panel.
 *  - ghost:   transparent w/ hairline border. The most common variant.
 *  - signal:  plot-red fill. Reserved for live-execution moments.
 *  - destructive: dropping data; paired with the literal verb.
 *  - link:    underlined ink text.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-none text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-plot-red disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-ink text-paper hover:bg-ink-soft",
        signal:
          "bg-plot-red text-paper hover:bg-plot-red-deep",
        // Full-fill destructive — reserved for the *firing* button inside a
        // confirmation modal. Don't use on page-level Delete triggers; use
        // ghost-destructive for those (the "Delete" wording is the affordance).
        destructive:
          "bg-destructive text-paper hover:bg-destructive/85",
        // Ghost destructive — the page-level Delete trigger. Subtle until
        // hovered, then leans red to telegraph the action.
        "ghost-destructive":
          "border border-paper-rule bg-transparent text-ink-soft hover:border-destructive hover:text-destructive",
        ghost:
          "border border-paper-rule bg-transparent text-ink hover:bg-paper-sunk",
        outline:
          "border border-paper-rule bg-paper text-ink hover:bg-paper-sunk",
        secondary:
          "bg-paper-sunk text-ink hover:bg-paper-rule",
        link:
          "text-ink underline-offset-4 hover:underline hover:text-plot-red",
      },
      size: {
        default: "h-9 px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-2.5 text-[13px] has-[>svg]:px-2",
        lg: "h-10 px-5 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
