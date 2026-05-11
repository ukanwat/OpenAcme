"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { Kbd } from "@/app/components/ui/kbd";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { cn } from "@/app/lib/utils";

interface ShortcutRow {
  combo: string[];
  description: string;
}

interface ConceptRow {
  term: string;
  body: string;
}

const GLOBAL_SHORTCUTS: ShortcutRow[] = [
  { combo: ["?", "or", "⌘", "/"], description: "Open this help" },
  { combo: ["Esc"], description: "Close this help / cancel modal" },
];

const PAGE_SHORTCUTS: Record<string, ShortcutRow[]> = {
  "/": [
    { combo: ["⏎"], description: "Send message" },
    { combo: ["⇧", "⏎"], description: "Newline" },
  ],
  "/agents": [],
  "/skills": [],
  "/tasks": [],
  "/settings": [],
};

const CONCEPTS: ConceptRow[] = [
  {
    term: "Agent",
    body: "A YAML+prose file at ~/.openacme/agents/<id>/AGENT.md. Owns model, tools, MCP servers, sessions, memory, and tasks.",
  },
  {
    term: "Session",
    body: "A conversation with one agent. Persists to SQLite. Tool calls and attachments belong to the session.",
  },
  {
    term: "Skill",
    body: "A markdown file with frontmatter. Its index is in the agent's prompt; the body loads on demand via skill_view.",
  },
  {
    term: "MCP server",
    body: "An external tool provider. Stdio or HTTP/SSE. Tools register at startup; each agent picks which servers to use.",
  },
  {
    term: "Task",
    body: "Per-agent unit of work that persists on disk. States: open, in_progress, blocked, done. Agents file them; you can intervene.",
  },
  {
    term: "Persona",
    body: "Prose at the bottom of AGENT.md. Becomes part of the agent's system prompt at every turn.",
  },
];

export function HelpOverlay() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && open) {
        setOpen(false);
        return;
      }
      // Cmd-/ or Ctrl-/ everywhere
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // Bare `?` only when not typing into an input/textarea
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const isEditable =
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable);
        if (isEditable) return;
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const pageShortcuts = PAGE_SHORTCUTS[pathname] ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Help"
    >
      {/* Backdrop — flat ink 60% (DESIGN.md command palette spec). */}
      <div
        className="absolute inset-0 bg-ink/60"
        onClick={() => setOpen(false)}
        aria-hidden
      />

      <div
        className={cn(
          "relative w-full max-w-2xl max-h-[80vh] overflow-y-auto",
          "border border-paper-rule bg-paper paper-surface",
          "section-enter"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3">
          <SectionEyebrow
            meta={
              <span className="flex items-center gap-1.5">
                <Kbd>Esc</Kbd>
                <span className="text-ink-faint">to close</span>
              </span>
            }
          >
            Help · {pathname}
          </SectionEyebrow>
        </div>

        {pageShortcuts.length > 0 && (
          <div className="px-5 pb-5">
            <div className="label-faceplate mb-2">Page shortcuts</div>
            <ul className="space-y-1.5">
              {pageShortcuts.map((s, i) => (
                <ShortcutLine key={i} {...s} />
              ))}
            </ul>
          </div>
        )}

        <div className="px-5 pb-5">
          <div className="label-faceplate mb-2">Global shortcuts</div>
          <ul className="space-y-1.5">
            {GLOBAL_SHORTCUTS.map((s, i) => (
              <ShortcutLine key={i} {...s} />
            ))}
          </ul>
        </div>

        <div className="border-t border-paper-rule px-5 py-5">
          <div className="label-faceplate mb-3">Key concepts</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3">
            {CONCEPTS.map((c) => (
              <ConceptRow key={c.term} {...c} />
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}

function ShortcutLine({ combo, description }: ShortcutRow) {
  return (
    <li className="flex items-baseline justify-between gap-4 text-[13px]">
      <span className="text-ink-soft">{description}</span>
      <span className="flex items-center gap-1 shrink-0">
        {combo.map((c, i) =>
          c === "or" ? (
            <span key={i} className="text-ink-faint text-[11px]">
              or
            </span>
          ) : (
            <Kbd key={i}>{c}</Kbd>
          )
        )}
      </span>
    </li>
  );
}

function ConceptRow({ term, body }: ConceptRow) {
  return (
    <>
      <dt className="font-mono text-[12px] text-ink whitespace-nowrap">
        {term}
      </dt>
      <dd className="text-[13px] leading-snug text-ink-soft">{body}</dd>
    </>
  );
}
