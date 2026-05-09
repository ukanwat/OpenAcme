// fzf 0.5.2's `dist/types/main.d.ts` does `export * from "./matchers"`
// without a `.js` extension. Under NodeNext module resolution TS can't
// follow that re-export, so symbols defined in `matchers.d.ts` are
// invisible to consumers — even though they're real runtime exports.
// Re-declare just the one we use. `export {}` at the bottom turns this
// file into a module so the `declare module` block augments rather
// than replaces fzf's existing declarations.
declare module "fzf" {
  export function extendedMatch<U>(
    this: unknown,
    query: string
  ): Array<{ item: U; positions: Set<number>; score: number }>;
}

export {};
