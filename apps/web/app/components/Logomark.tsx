import { cn } from "@/app/lib/utils";

/*
 * Compact robot mark — pixel-art rendering of the CLI's ASCII logo:
 *
 *    ▄▄▄
 *     █
 *  ▄██████▄
 * ██  ██  ██
 * ██████████
 *
 * Uses currentColor so it inherits text-* classes — wrap in text-ink
 * (or any text color) to recolor.
 */
export function Logomark({
  className,
  title = "OpenAcme",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      role="img"
      aria-label={title}
      viewBox="0 0 10 10"
      shapeRendering="crispEdges"
      className={cn("block select-none", className)}
      fill="currentColor"
    >
      <title>{title}</title>
      {/* Each char cell = 2 SVG units tall × 1 wide, matching the
          CLI's terminal aspect ratio (cells are ~2:1 tall:wide).
          ▄ = lower-half block → 1-unit-tall rect at the bottom of
          its 2-unit cell. */}
      <rect x="3" y="1" width="3" height="1" />
      <rect x="4" y="2" width="1" height="2" />
      <rect x="1" y="5" width="1" height="1" />
      <rect x="2" y="4" width="6" height="2" />
      <rect x="8" y="5" width="1" height="1" />
      <rect x="0" y="6" width="2" height="2" />
      <rect x="4" y="6" width="2" height="2" />
      <rect x="8" y="6" width="2" height="2" />
      <rect x="0" y="8" width="10" height="2" />
    </svg>
  );
}
