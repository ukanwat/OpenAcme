import { cn } from "@/app/lib/utils";

// The 2px plot-red active marker — the DESIGN.md-allowed side-stripe
// exception, used on sidebar nav and roster rows where the whole row is
// the affordance. Always lives on a `relative` parent.
export function ActiveMarker({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute inset-y-0 left-0 w-[2px] bg-plot-red transition-opacity",
        active ? "opacity-100" : "opacity-0",
        className
      )}
    />
  );
}
