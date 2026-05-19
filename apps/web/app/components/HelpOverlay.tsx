"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Kbd } from "@/app/components/ui/kbd";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";

interface ShortcutRow {
  combo: string[];
  description: string;
}

interface ConceptRow {
  term: string;
  body: string;
}

const GLOBAL_SHORTCUTS: ShortcutRow[] = [
  { combo: ["⌘", "K"], description: "Open command palette" },
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
      // Esc is handled by Radix internally when the dialog is open.
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
    // Other surfaces (command palette) can request this overlay
    // programmatically. Window-scoped CustomEvent so the contract is
    // explicit — no synthesized keypresses.
    function onOpenHelp() {
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    window.addEventListener("openacme:open-help", onOpenHelp);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("openacme:open-help", onOpenHelp);
    };
  }, []);

  const pageShortcuts = PAGE_SHORTCUTS[pathname] ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogTitle className="sr-only">Help</DialogTitle>
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

        <DialogBody className="max-h-[70vh] overflow-y-auto">
          {pageShortcuts.length > 0 && (
            <div className="pb-5">
              <div className="label-faceplate mb-2">Page shortcuts</div>
              <ul className="space-y-1.5">
                {pageShortcuts.map((s, i) => (
                  <ShortcutLine key={i} {...s} />
                ))}
              </ul>
            </div>
          )}

          <div className="pb-5">
            <div className="label-faceplate mb-2">Global shortcuts</div>
            <ul className="space-y-1.5">
              {GLOBAL_SHORTCUTS.map((s, i) => (
                <ShortcutLine key={i} {...s} />
              ))}
            </ul>
          </div>

          <div className="border-t border-paper-rule pt-5">
            <div className="label-faceplate mb-3">Key concepts</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3">
              {CONCEPTS.map((c) => (
                <ConceptRow key={c.term} {...c} />
              ))}
            </dl>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
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
