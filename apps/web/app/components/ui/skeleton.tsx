import { cn } from "@/app/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("rounded-none bg-paper-sunk pulse-live", className)}
      {...props}
    />
  )
}

export { Skeleton }
