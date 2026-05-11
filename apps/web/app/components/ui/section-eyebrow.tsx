import * as React from "react"

import { cn } from "@/app/lib/utils"
import { ScribedRule } from "./scribed-rule"

export function SectionEyebrow({
  children,
  className,
  meta,
  rule = true,
  ruleDelay,
}: {
  children: React.ReactNode
  className?: string
  meta?: React.ReactNode
  rule?: boolean
  ruleDelay?: number
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="label-faceplate">{children}</div>
        {meta && <div className="meta-row">{meta}</div>}
      </div>
      {rule && <ScribedRule delay={ruleDelay} />}
    </div>
  )
}
