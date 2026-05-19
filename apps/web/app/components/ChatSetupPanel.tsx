"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowRight } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import { Logotype } from "@/app/components/Logotype";
import { API_BASE } from "@/app/lib/api";
import type { ProviderInfo } from "../lib/types";
import { cn } from "@/app/lib/utils";

const PROVIDER_INFO: Record<string, { tagline: string; docsUrl: string }> = {
  openrouter: {
    tagline: "one key, many models",
    docsUrl: "https://openrouter.ai/keys",
  },
  anthropic: {
    tagline: "Claude · key or Pro subscription",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    tagline: "GPT · key or ChatGPT subscription",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  google: {
    tagline: "Gemini",
    docsUrl: "https://aistudio.google.com/apikey",
  },
};

// Order matters — OpenRouter first (broadest, project default), then the
// subscription-capable pair, then Google.
const PROVIDER_ORDER = ["openrouter", "anthropic", "openai", "google"];

type Step = 0 | 1 | 2;
const TOTAL_STEPS = 3;
const STEP_LABEL: Record<Step, string> = {
  0: "WELCOME",
  1: "SUBSTRATE",
  2: "PROVIDER",
};

export interface ChatSetupPanelProps {
  providers: ProviderInfo[];
  /** Called after credential save so the parent re-fetches /api/keys. */
  onSetup: () => void | Promise<void>;
}

export function ChatSetupPanel({ providers, onSetup }: ChatSetupPanelProps) {
  const [step, setStep] = useState<Step>(0);

  const offered = useMemo(
    () =>
      PROVIDER_ORDER.map((id) => providers.find((p) => p.id === id)).filter(
        (p): p is ProviderInfo => !!p && !!p.envVar
      ),
    [providers]
  );

  const [picked, setPicked] = useState<string>(() => offered[0]?.id ?? "");
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false);
  const [ccImporting, setCcImporting] = useState(false);
  const [oauthSubmitting, setOauthSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/setup/claude-code-available`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.available === "boolean") {
          setClaudeCodeAvailable(data.available);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const pickedProvider = offered.find((p) => p.id === picked);
  const supportsSubscription =
    pickedProvider?.id === "openai" ||
    (pickedProvider?.id === "anthropic" && claudeCodeAvailable);

  async function save() {
    if (!pickedProvider) {
      toast.error("Pick a provider above first");
      return;
    }
    const trimmed = apiKey.trim();
    if (!trimmed) {
      toast.error("Paste an API key");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch(`${API_BASE}/api/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: pickedProvider.id, apiKey: trimmed }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      toast.success(`${pickedProvider.name} configured`);
      await onSetup();
    } catch (e) {
      toast.error("Save failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function signInWithOpenAI() {
    setOauthSubmitting(true);
    toast.message("Opened your browser to sign in", {
      description: "Complete the flow there. This tab will update when done.",
    });
    try {
      const r = await fetch(`${API_BASE}/api/setup/oauth-start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai" }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        error?: string;
        email?: string | null;
      };
      if (!r.ok) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      toast.success(
        data.email ? `Signed in as ${data.email}` : "ChatGPT subscription linked"
      );
      await onSetup();
    } catch (e) {
      toast.error("Sign-in failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setOauthSubmitting(false);
    }
  }

  async function importFromClaudeCode() {
    setCcImporting(true);
    try {
      const r = await fetch(
        `${API_BASE}/api/setup/anthropic-claude-code-import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ importNow: true }),
        }
      );
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      toast.success("Imported from Claude Code");
      await onSetup();
    } catch (e) {
      toast.error("Import failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setCcImporting(false);
    }
  }

  return (
    <div className="relative mx-auto flex min-h-screen max-w-2xl flex-col px-6 pb-24 pt-16">
      <div
        style={{ animation: "section-enter 220ms var(--ease-out-quart) both" }}
      >
        <Logotype className="h-7 w-auto text-ink" />
      </div>

      <div key={step} className="section-enter mt-10 flex-1">
        {step === 0 && <ScreenWelcome onNext={() => setStep(1)} />}
        {step === 1 && (
          <ScreenSubstrate
            onNext={() => setStep(2)}
            onBack={() => setStep(0)}
          />
        )}
        {step === 2 && (
          <ScreenProvider
            offered={offered}
            picked={picked}
            onPick={(id) => {
              setPicked(id);
              setApiKey("");
            }}
            apiKey={apiKey}
            onApiKeyChange={setApiKey}
            submitting={submitting}
            onSave={save}
            pickedProvider={pickedProvider}
            supportsSubscription={supportsSubscription}
            oauthSubmitting={oauthSubmitting}
            onOpenAISignIn={signInWithOpenAI}
            ccImporting={ccImporting}
            onImportClaudeCode={importFromClaudeCode}
          />
        )}
      </div>

      <StepBar
        step={step}
        onJump={setStep}
      />
    </div>
  );
}

// ─── Screen 0: Welcome ────────────────────────────────────────────────────

function ScreenWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-10">
      <div className="space-y-5">
        <TeletypeMarker text="00 · WELCOME" startMs={120} stepMs={28} />
        <h1 className="max-w-prose text-[28px] font-semibold leading-[1.15] tracking-[-0.01em] text-ink">
          The operator&apos;s console for an agent workforce.
        </h1>
        <p className="max-w-prose text-[15px] leading-[1.6] text-ink-soft">
          You&apos;re the operator. OpenAcme runs a workforce of agents for you,
          on this machine. Configure as many as you want; each gets its own
          model, tools, and memory. They file tasks, run tools, and remember
          context across sessions. Walk through what&apos;s in the box, then
          connect a model provider.
        </p>
      </div>

      <SchematicTopology />

      <div className="flex items-center justify-end">
        <Button onClick={onNext}>
          Continue
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ─── Screen 1: Substrate ──────────────────────────────────────────────────

function ScreenSubstrate({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-10">
      <div className="space-y-5">
        <TeletypeMarker text="01 · WHAT'S RUNNING" startMs={120} stepMs={28} />
        <h2 className="max-w-prose text-[24px] font-semibold leading-[1.2] tracking-[-0.01em] text-ink">
          Four nouns. Each one a real file you can open, read, edit, move.
        </h2>
        <p className="max-w-prose text-[14px] leading-relaxed text-ink-soft">
          OpenAcme is not a chat tool. It&apos;s a substrate. The interface above is
          a window into these four kinds of state, all sitting on your disk.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-px border border-paper-rule bg-paper-rule">
        <Tile
          label="Agents"
          teaching="A coworker. Has its own model, tools, persona, memory."
          body={
            <div className="space-y-1">
              <div className="font-mono text-[12px] text-ink-soft">
                ~/.openacme/agents/alice/AGENT.md
              </div>
              <div className="font-mono text-[11px] text-ink-faint">
                yaml frontmatter · prose persona · tools list
              </div>
            </div>
          }
        />
        <Tile
          label="Sessions"
          teaching="A conversation. Append-only, persisted, replayable."
          body={
            <div className="space-y-1.5">
              {[
                { from: "you", txt: "what changed on main since friday?" },
                { from: "alice", txt: "diffing now: 3 PRs, 1 release tag." },
                { from: "you", txt: "summarize the release notes." },
              ].map((m, i) => (
                <div
                  key={i}
                  className="flex items-baseline gap-2 font-mono text-[11px]"
                >
                  <span
                    className={cn(
                      "shrink-0 uppercase tracking-[0.08em]",
                      m.from === "you" ? "text-ink-faint" : "text-plot-red"
                    )}
                  >
                    {m.from}
                  </span>
                  <span className="truncate text-ink-soft">{m.txt}</span>
                </div>
              ))}
            </div>
          }
        />
        <Tile
          label="Tasks"
          teaching="Work routed between agents. Status tracked, scheduled, recurring."
          body={<TaskCycleDemo />}
        />
        <Tile
          label="Tools"
          teaching="What an agent can do. Shell, files, web, code, MCP servers."
          body={
            <div className="space-y-1">
              <div className="font-mono text-[11px] text-ink-soft">
                <span className="text-plot-red">$ </span>
                rg &apos;session_id&apos; packages/db --type ts
              </div>
              <div className="font-mono text-[11px] text-ink-faint">
                12 matches · 47ms
              </div>
            </div>
          }
        />
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint transition-colors hover:text-plot-red"
        >
          ← Back
        </button>
        <Button onClick={onNext}>
          Continue
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ─── Screen 2: Provider ───────────────────────────────────────────────────

function ScreenProvider(props: ProviderFormProps & {
  supportsSubscription: boolean;
  oauthSubmitting: boolean;
  onOpenAISignIn: () => void;
  ccImporting: boolean;
  onImportClaudeCode: () => void;
}) {
  return (
    <div className="space-y-10">
      <div className="space-y-5">
        <TeletypeMarker text="02 · PROVIDER" startMs={120} stepMs={28} />
        <h2 className="max-w-prose text-[24px] font-semibold leading-[1.2] tracking-[-0.01em] text-ink">
          One credential to bring the workforce online.
        </h2>
        <p className="max-w-prose text-[14px] leading-relaxed text-ink-soft">
          Keys live in <code>~/.openacme/.env</code> on your machine. They
          never leave this box except as calls to the provider you pick.
        </p>
      </div>

      <ProviderForm {...props} />

      {props.supportsSubscription && props.pickedProvider && (
        <SubscriptionBlock
          provider={props.pickedProvider.id as "anthropic" | "openai"}
          oauthSubmitting={props.oauthSubmitting}
          onOpenAISignIn={props.onOpenAISignIn}
          ccImporting={props.ccImporting}
          onImportClaudeCode={props.onImportClaudeCode}
        />
      )}
    </div>
  );
}

// ─── Provider form (shared between wizard screen 2 and returning-user view)

interface ProviderFormProps {
  offered: ProviderInfo[];
  picked: string;
  onPick: (id: string) => void;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  submitting: boolean;
  onSave: () => void;
  pickedProvider: ProviderInfo | undefined;
}

function ProviderForm({
  offered,
  picked,
  onPick,
  apiKey,
  onApiKeyChange,
  submitting,
  onSave,
  pickedProvider,
}: ProviderFormProps) {
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionEyebrow meta={`${offered.length} listed`}>
          Provider
        </SectionEyebrow>
        <div className="border-y border-paper-rule">
          {offered.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              active={p.id === picked}
              onPick={() => onPick(p.id)}
            />
          ))}
        </div>
      </section>

      {pickedProvider && (
        <section key={pickedProvider.id} className="section-enter space-y-3">
          <SectionEyebrow meta={pickedProvider.envVar}>Credential</SectionEyebrow>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`Paste ${pickedProvider.envVar}`}
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSave();
              }
            }}
            disabled={submitting}
            className="font-mono"
          />
          <div className="flex items-center justify-end">
            <Button onClick={onSave} disabled={submitting || !apiKey.trim()}>
              {submitting ? (
                <span className="inline-flex items-center gap-2">
                  <LoadingHairline inline aria-label="Saving" />
                  Saving
                </span>
              ) : (
                <>
                  Save and chat
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Tiles for the substrate screen ───────────────────────────────────────

function Tile({
  label,
  teaching,
  body,
}: {
  label: string;
  teaching: string;
  body: React.ReactNode;
}) {
  return (
    <div className="bg-paper p-4">
      <div className="label-faceplate mb-2">{label}</div>
      <p className="mb-3 text-[13px] leading-snug text-ink">{teaching}</p>
      <div className="min-h-[4.5rem] border-t border-paper-rule pt-3">{body}</div>
    </div>
  );
}

function TaskCycleDemo() {
  const STATES = [
    { label: "OPEN", className: "bg-signal-amber" },
    { label: "IN_PROGRESS", className: "bg-plot-red" },
    { label: "DONE", className: "bg-ink" },
  ];
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % STATES.length), 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const current = STATES[idx]!;
  return (
    <div className="space-y-2">
      <div className="truncate font-mono text-[12px] text-ink-soft">
        investigate failing build on main
      </div>
      <div className="flex items-center gap-1.5">
        <span aria-hidden className={cn("status-dot", current.className)} />
        <span key={idx} className="label-faceplate tick">
          {current.label}
        </span>
      </div>
    </div>
  );
}


// ─── Schematic ────────────────────────────────────────────────────────────

/**
 * Org-chart topology: YOU at the top, 3 agents reporting in directly.
 * Workforce framing. Sits on a dot-grid backing for the blueprint feel.
 * Plotter-pen draw-in via stroke-dashoffset; pulse-live dots mark active.
 */
function SchematicTopology() {
  // Four-layer hierarchy: founder → platform → directors → workers.
  // Tells the "agent workforce, not a chat tool" story by depth.
  const directors = [
    {
      x: 80,
      label: "marketing",
      workers: [
        { x: 35, label: "writer", live: true },
        { x: 125, label: "designer", live: false },
      ],
    },
    {
      x: 250,
      label: "engineering",
      workers: [
        { x: 205, label: "backend", live: true },
        { x: 295, label: "frontend", live: false },
      ],
    },
    {
      x: 420,
      label: "operations",
      workers: [
        { x: 375, label: "finance", live: false },
        { x: 465, label: "support", live: true },
      ],
    },
  ];

  return (
    <svg
      viewBox="0 0 500 360"
      className="section-enter w-full max-w-[480px] text-ink-soft"
      aria-hidden
    >
      {/* L1 — YOU */}
      <rect
        x="210" y="10" width="80" height="34"
        fill="var(--paper)"
        stroke="currentColor" strokeWidth="1"
      />
      <text x="250" y="32" textAnchor="middle"
        className="fill-ink font-mono"
        style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        you
      </text>

      {/* L1 → L2 spine */}
      <path
        d="M250 44 L250 70"
        stroke="currentColor" strokeWidth="1" fill="none"
      />

      {/* L2 — OPENACME */}
      <rect
        x="170" y="70" width="160" height="42"
        fill="var(--paper)"
        stroke="currentColor" strokeWidth="1"
      />
      <text x="250" y="90" textAnchor="middle"
        className="fill-ink font-mono"
        style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        openacme
      </text>
      <text x="250" y="104" textAnchor="middle"
        className="fill-ink-faint font-mono"
        style={{ fontSize: 10 }}>
        on your machine
      </text>

      {/* L2 → director branch */}
      <path
        d="M250 112 L250 140"
        stroke="currentColor" strokeWidth="1" fill="none"
      />
      <path
        d="M80 140 L420 140"
        stroke="currentColor" strokeWidth="1" fill="none"
      />
      {directors.map((d, i) => (
        <path
          key={`drop-d-${i}`}
          d={`M${d.x} 140 L${d.x} 162`}
          stroke="currentColor" strokeWidth="1" fill="none"
        />
      ))}

      {/* L3 — Directors */}
      {directors.map((d, i) => (
        <g key={`dir-${i}`}>
          <rect
            x={d.x - 50} y="162" width="100" height="34"
            fill="var(--paper)"
            stroke="currentColor" strokeWidth="1"
          />
          <text x={d.x} y="184" textAnchor="middle"
            className="fill-ink font-mono"
            style={{ fontSize: 11, letterSpacing: "0.05em" }}>
            {d.label}
          </text>
        </g>
      ))}

      {/* L3 → worker branches (one mini-branch per director) */}
      {directors.map((d, i) => (
        <g key={`branch-w-${i}`}>
          <path
            d={`M${d.x} 196 L${d.x} 222`}
            stroke="currentColor" strokeWidth="1" fill="none"
          />
          <path
            d={`M${d.workers[0]!.x} 222 L${d.workers[1]!.x} 222`}
            stroke="currentColor" strokeWidth="1" fill="none"
          />
          {d.workers.map((w, wi) => (
            <path
              key={`drop-w-${i}-${wi}`}
              d={`M${w.x} 222 L${w.x} 244`}
              stroke="currentColor" strokeWidth="1" fill="none"
            />
          ))}
        </g>
      ))}

      {/* L4 — Workers */}
      {directors.flatMap((d, i) =>
        d.workers.map((w, wi) => (
          <g key={`worker-${i}-${wi}`}>
            <rect
              x={w.x - 32} y="244" width="64" height="32"
              fill="var(--paper)"
              stroke="currentColor" strokeWidth="1"
            />
            <text x={w.x} y="264" textAnchor="middle"
              className="fill-ink-soft font-mono"
              style={{ fontSize: 10, letterSpacing: "0.04em" }}>
              {w.label}
            </text>
            {w.live && (
              <circle
                cx={w.x + 25} cy="251" r="2.2"
                className="fill-plot-red pulse-live"
              />
            )}
          </g>
        ))
      )}
    </svg>
  );
}

// ─── Step indicator + skip ────────────────────────────────────────────────

function StepBar({ step, onJump }: { step: Step; onJump: (s: Step) => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex items-center justify-between px-6">
      <div className="pointer-events-auto flex items-center gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
          {String(step).padStart(2, "0")} / {String(TOTAL_STEPS - 1).padStart(2, "0")} · {STEP_LABEL[step]}
        </span>
        <span className="flex items-center gap-1.5">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onJump(i as Step)}
              aria-label={`Go to step ${i + 1}`}
              className={cn(
                "size-1.5 transition-colors",
                i === step
                  ? "bg-plot-red"
                  : i < step
                  ? "bg-ink"
                  : "bg-paper-rule hover:bg-ink-faint"
              )}
            />
          ))}
        </span>
      </div>
      {step < 2 && (
        <button
          type="button"
          onClick={() => onJump(2)}
          className="pointer-events-auto font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint transition-colors hover:text-plot-red"
        >
          Skip · I have a key →
        </button>
      )}
    </div>
  );
}

// ─── Teletype marker ──────────────────────────────────────────────────────

function TeletypeMarker({
  text,
  startMs = 0,
  stepMs = 30,
}: {
  text: string;
  startMs?: number;
  stepMs?: number;
}) {
  return (
    <span aria-label={text} className="label-faceplate text-ink">
      <span aria-hidden>
        {text.split("").map((ch, i) => (
          <span
            key={i}
            className="inline-block"
            style={{
              animation: "section-enter 220ms var(--ease-out-quart) both",
              animationDelay: `${startMs + i * stepMs}ms`,
              //   instead of " " so inline-block spans for whitespace
              // don't collapse to zero width — "01 · WHAT" would render as
              // "01·WHAT" otherwise.
              whiteSpace: ch === " " ? "pre" : undefined,
            }}
          >
            {ch === " " ? " " : ch}
          </span>
        ))}
      </span>
    </span>
  );
}

// ─── Provider row + subscription block ────────────────────────────────────

function ProviderRow({
  provider,
  active,
  onPick,
}: {
  provider: ProviderInfo;
  active: boolean;
  onPick: () => void;
}) {
  const info = PROVIDER_INFO[provider.id];
  return (
    <div className="group relative flex w-full items-center gap-3 border-b border-paper-rule px-4 py-3 transition-colors last:border-b-0">
      <ActiveMarker active={active} />
      <button
        type="button"
        onClick={onPick}
        className="flex flex-1 items-center gap-3 text-left"
      >
        <span className="w-24 shrink-0 text-sm font-medium text-ink">
          {provider.name}
        </span>
        <span className="flex-1 text-sm text-ink-soft">
          {info?.tagline ?? ""}
        </span>
        <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">
          {provider.envVar}
        </span>
      </button>
      {info?.docsUrl && (
        <a
          href={info.docsUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint transition-colors hover:text-plot-red"
        >
          Docs ↗
        </a>
      )}
    </div>
  );
}

function SubscriptionBlock({
  provider,
  oauthSubmitting,
  onOpenAISignIn,
  ccImporting,
  onImportClaudeCode,
}: {
  provider: "anthropic" | "openai";
  oauthSubmitting: boolean;
  onOpenAISignIn: () => void;
  ccImporting: boolean;
  onImportClaudeCode: () => void;
}) {
  return (
    <section key={provider} className="section-enter space-y-3">
      <SectionEyebrow meta="optional">Subscription</SectionEyebrow>

      {provider === "openai" && (
        <div className="space-y-3">
          <p className="max-w-prose text-[14px] leading-relaxed text-ink-soft">
            Already paying for ChatGPT? Sign in with your subscription
            instead of pasting a key. Your sub's quota applies; no extra
            cost.
          </p>
          <div className="flex items-center justify-end">
            <Button
              variant="ghost"
              onClick={onOpenAISignIn}
              disabled={oauthSubmitting}
            >
              {oauthSubmitting ? (
                <span className="inline-flex items-center gap-2">
                  <LoadingHairline inline aria-label="Waiting for browser" />
                  Waiting for browser
                </span>
              ) : (
                "Sign in with ChatGPT"
              )}
            </Button>
          </div>
        </div>
      )}

      {provider === "anthropic" && (
        <div className="space-y-3">
          <p className="max-w-prose text-[14px] leading-relaxed text-ink-soft">
            Claude Code is installed on this machine. Import its
            credentials to reuse the same Anthropic session. On macOS the
            system may prompt for Touch ID to read the keychain.
          </p>
          <div className="flex items-center justify-end">
            <Button
              variant="ghost"
              onClick={onImportClaudeCode}
              disabled={ccImporting}
            >
              {ccImporting ? (
                <span className="inline-flex items-center gap-2">
                  <LoadingHairline inline aria-label="Importing" />
                  Importing
                </span>
              ) : (
                "Import from Claude Code"
              )}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
