import { cn } from "@/app/lib/utils";

/*
 * The OpenAcme wordmark. Uses currentColor + a mask so it inherits the
 * surrounding text color — wrap it in a `text-ink` (or any text-*) class
 * to recolor.
 */
export function Logotype({
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
      viewBox="0 0 500 78"
      className={cn("block h-auto w-32 select-none", className)}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{title}</title>
      <defs>
        <mask
          id="openacme-logotype-mask"
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="500"
          height="78"
        >
          <rect width="500" height="78" fill="white" />
          <g transform="translate(0,78) scale(0.1,-0.1)" fill="black" stroke="none">
            <path d="M0 390 l0 -390 2500 0 2500 0 0 390 0 390 -2500 0 -2500 0 0 -390z m560 -10 l0 -280 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -280z m560 70 l0 -210 -140 0 -140 0 0 -70 0 -70 -70 0 -70 0 0 280 0 280 210 0 210 0 0 -210z m560 140 l0 -70 -140 0 -140 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -70z m280 0 l0 -70 70 0 70 0 0 -70 0 -70 70 0 70 0 0 140 0 140 70 0 70 0 0 -280 0 -280 -70 0 -70 0 0 70 0 70 -70 0 -70 0 0 70 0 70 -70 0 -70 0 0 -140 0 -140 -70 0 -70 0 0 280 0 280 70 0 70 0 0 -70z m980 -210 l0 -280 -70 0 -70 0 0 70 0 70 -70 0 -70 0 0 -70 0 -70 -70 0 -70 0 0 210 0 210 70 0 70 0 0 70 0 70 140 0 140 0 0 -280z m560 210 l0 -70 -140 0 -140 0 0 -140 0 -140 140 0 140 0 0 -70 0 -70 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -70z m420 0 l0 -70 70 0 70 0 0 70 0 70 140 0 140 0 0 -280 0 -280 -70 0 -70 0 0 210 0 210 -70 0 -70 0 0 -140 0 -140 -70 0 -70 0 0 140 0 140 -70 0 -70 0 0 -210 0 -210 -70 0 -70 0 0 280 0 280 140 0 140 0 0 -70z m980 0 l0 -70 -140 0 -140 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -70z" />
            <path d="M280 380 l0 -140 70 0 70 0 0 140 0 140 -70 0 -70 0 0 -140z" />
            <path d="M840 450 l0 -70 70 0 70 0 0 70 0 70 -70 0 -70 0 0 -70z" />
            <path d="M2660 450 l0 -70 70 0 70 0 0 70 0 70 -70 0 -70 0 0 -70z" />
          </g>
        </mask>
      </defs>
      <rect
        width="500"
        height="78"
        fill="currentColor"
        mask="url(#openacme-logotype-mask)"
      />
    </svg>
  );
}
