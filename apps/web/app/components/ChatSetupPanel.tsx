"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

const WELCOME_SEEN_KEY = "openacme.onboarding.welcome.seen";

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
  // Returning users skip the welcome cascade and land directly on the
  // provider screen. Wizard mode is exclusively first-run.
  const [seen, setSeen] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setSeen(window.localStorage.getItem(WELCOME_SEEN_KEY) === "1");
    } catch {
      setSeen(false);
    }
  }, []);

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

  function markSeen() {
    try {
      window.localStorage.setItem(WELCOME_SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  }

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
      markSeen();
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
      markSeen();
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
      markSeen();
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

  // Don't render the wizard until we know whether the user has seen it.
  // Avoids a one-frame flash of the welcome screen for returning users.
  if (seen === null) {
    return null;
  }

  // Returning users (cleared keys, came back) skip the cascade entirely.
  if (seen) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <div
          style={{ animation: "section-enter 220ms var(--ease-out-quart) both" }}
        >
          <Logotype className="h-7 w-auto text-ink" />
        </div>
        <div className="mt-12">
          <ProviderForm
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
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative mx-auto flex min-h-screen max-w-2xl flex-col px-6 pb-24 pt-16">
      <div
        style={{ animation: "section-enter 220ms var(--ease-out-quart) both" }}
      >
        <Logotype className="h-7 w-auto text-ink" />
      </div>

      <div key={step} className="mt-10 flex-1 section-enter">
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
        <h1
          className="max-w-prose text-[28px] font-semibold leading-[1.15] tracking-[-0.01em] text-ink"
          style={{
            animation: "section-enter 380ms var(--ease-out-quart) both",
            animationDelay: "520ms",
          }}
        >
          <DecryptedText
            text="The operator's console for an agent workforce."
            startDelayMs={520}
            speed={32}
          />
        </h1>
        <p
          className="max-w-prose text-[15px] leading-[1.6] text-ink-soft"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: "1100ms",
          }}
        >
          You're the operator. OpenAcme runs a workforce of agents for you,
          on this machine. Configure as many as you want; each gets its own
          model, tools, and memory. They file tasks, run tools, and remember
          context across sessions. Walk through what's in the box, then
          connect a model provider.
        </p>
      </div>

      <div
        style={{
          animation: "section-enter 380ms var(--ease-out-quart) both",
          animationDelay: "1300ms",
        }}
      >
        <SchematicTopology />
      </div>

      <div
        className="flex items-center justify-end"
        style={{
          animation: "section-enter 280ms var(--ease-out-quart) both",
          animationDelay: "1700ms",
        }}
      >
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
        <h2
          className="max-w-prose text-[24px] font-semibold leading-[1.2] tracking-[-0.01em] text-ink"
          style={{
            animation: "section-enter 360ms var(--ease-out-quart) both",
            animationDelay: "440ms",
          }}
        >
          Four nouns. Each one a real file you can open, read, edit, move.
        </h2>
        <p
          className="max-w-prose text-[14px] leading-relaxed text-ink-soft"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: "640ms",
          }}
        >
          OpenAcme is not a chat tool. It's a substrate. The interface above is
          a window into these four kinds of state, all sitting on your disk.
        </p>
      </div>

      <div
        className="grid grid-cols-2 gap-px border border-paper-rule bg-paper-rule"
        style={{
          animation: "section-enter 380ms var(--ease-out-quart) both",
          animationDelay: "780ms",
        }}
      >
        <Tile
          label="Agents"
          teaching="A coworker. Has its own model, tools, persona, memory."
          body={
            <div className="space-y-1">
              <div className="font-mono text-[12px] text-ink-soft">
                <DecryptedText
                  text="~/.openacme/agents/alice/AGENT.md"
                  startDelayMs={900}
                  speed={26}
                  charset="abcdefghijklmnopqrstuvwxyz/.-_"
                />
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
                  style={{
                    animation: "section-enter 320ms var(--ease-out-quart) both",
                    animationDelay: `${1100 + i * 220}ms`,
                  }}
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
                <DecryptedText
                  text="rg 'session_id' packages/db --type ts"
                  startDelayMs={1300}
                  speed={22}
                  charset="abcdefghijklmnopqrstuvwxyz_-/."
                />
              </div>
              <div
                className="font-mono text-[11px] text-ink-faint"
                style={{
                  animation: "section-enter 280ms var(--ease-out-quart) both",
                  animationDelay: "2300ms",
                }}
              >
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
        <h2
          className="max-w-prose text-[24px] font-semibold leading-[1.2] tracking-[-0.01em] text-ink"
          style={{
            animation: "section-enter 360ms var(--ease-out-quart) both",
            animationDelay: "440ms",
          }}
        >
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
    { label: "IN_PROGRESS", className: "bg-plot-red pulse-live" },
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
  const agents = [
    { x: 90, label: "agent 01", live: true },
    { x: 240, label: "agent 02", live: false },
    { x: 390, label: "agent 03", live: true },
  ];
  return (
    <svg
      viewBox="0 0 480 260"
      className="w-full max-w-[460px] text-ink-soft"
      aria-hidden
    >
      <style>{`
        .draw {
          stroke-dasharray: var(--len, 400);
          stroke-dashoffset: var(--len, 400);
          animation: draw-path 900ms cubic-bezier(0.25, 1, 0.5, 1) both;
        }
        @keyframes draw-path { to { stroke-dashoffset: 0; } }
        @media (prefers-reduced-motion: reduce) {
          .draw { animation: none; stroke-dashoffset: 0; }
        }
      `}</style>

      {/* YOU box at top center */}
      <rect
        x="200" y="14" width="80" height="34"
        fill="var(--paper)"
        stroke="currentColor" strokeWidth="1"
        className="draw"
        style={{ ["--len" as string]: 228, animationDelay: "100ms" }}
      />
      <text x="240" y="36" textAnchor="middle"
        className="fill-ink font-mono"
        style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        you
      </text>

      {/* You → OpenAcme spine */}
      <path
        d="M240 48 L240 82"
        stroke="currentColor" strokeWidth="1" fill="none"
        className="draw"
        style={{ ["--len" as string]: 34, animationDelay: "500ms" }}
      />

      {/* OpenAcme box — wider, identifies the system between user and workforce */}
      <rect
        x="160" y="82" width="160" height="44"
        fill="var(--paper)"
        stroke="currentColor" strokeWidth="1"
        className="draw"
        style={{ ["--len" as string]: 408, animationDelay: "650ms" }}
      />
      <text x="240" y="103" textAnchor="middle"
        className="fill-ink font-mono"
        style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        openacme
      </text>
      <text x="240" y="118" textAnchor="middle"
        className="fill-ink-faint font-mono"
        style={{ fontSize: 10 }}>
        on your machine
      </text>

      {/* OpenAcme → branch line spine */}
      <path
        d="M240 126 L240 160"
        stroke="currentColor" strokeWidth="1" fill="none"
        className="draw"
        style={{ ["--len" as string]: 34, animationDelay: "1000ms" }}
      />

      {/* Horizontal branch spanning the three agents */}
      <path
        d="M90 160 L390 160"
        stroke="currentColor" strokeWidth="1" fill="none"
        className="draw"
        style={{ ["--len" as string]: 300, animationDelay: "1150ms" }}
      />

      {/* Vertical drops to each agent */}
      {agents.map((a, i) => (
        <path
          key={`drop-${i}`}
          d={`M${a.x} 160 L${a.x} 196`}
          stroke="currentColor" strokeWidth="1" fill="none"
          className="draw"
          style={{ ["--len" as string]: 36, animationDelay: `${1400 + i * 100}ms` }}
        />
      ))}

      {/* Agent boxes */}
      {agents.map((a, i) => (
        <g key={`agent-${i}`}>
          <rect
            x={a.x - 40} y="196" width="80" height="36"
            fill="var(--paper)"
            stroke="currentColor" strokeWidth="1"
            className="draw"
            style={{
              ["--len" as string]: 232,
              animationDelay: `${1650 + i * 120}ms`,
            }}
          />
          <text x={a.x} y="218" textAnchor="middle"
            className="fill-ink-soft font-mono"
            style={{ fontSize: 11, letterSpacing: "0.05em" }}>
            {a.label}
          </text>
          {/* Live pip on active agents */}
          {a.live && (
            <circle
              cx={a.x + 32} cy="204" r="2.5"
              className="fill-plot-red"
              style={{
                animation: `pulse-live var(--duration-pulse) var(--ease-out-quart) infinite ${2200 + i * 200}ms`,
              }}
            />
          )}
        </g>
      ))}
    </svg>
  );
}

// ─── Decrypted-text reveal (React-Bits technique) ─────────────────────────

const DEFAULT_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*";

/**
 * Characters scramble through a charset, then progressively lock to the
 * target string from left to right. Fits OpenAcme's lab-instrument
 * register (reads like data resolving on an instrument display).
 */
function DecryptedText({
  text,
  startDelayMs = 0,
  speed = 50,
  charset = DEFAULT_CHARSET,
  className,
}: {
  text: string;
  startDelayMs?: number;
  speed?: number;
  charset?: string;
  className?: string;
}) {
  const [displayed, setDisplayed] = useState(text);
  const [started, setStarted] = useState(false);
  const lockedRef = useRef(0);

  useEffect(() => {
    // Respect reduced motion — show target string immediately.
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      setDisplayed(text);
      return;
    }
    const startTimer = setTimeout(() => setStarted(true), startDelayMs);
    return () => clearTimeout(startTimer);
  }, [text, startDelayMs]);

  useEffect(() => {
    if (!started) {
      // Pre-start placeholder: show all-scrambled.
      const scrambled = text
        .split("")
        .map((ch) =>
          ch === " " ? " " : charset[Math.floor(Math.random() * charset.length)]
        )
        .join("");
      setDisplayed(scrambled);
      return;
    }
    lockedRef.current = 0;
    const interval = setInterval(() => {
      const locked = lockedRef.current;
      const next = text
        .split("")
        .map((ch, i) => {
          if (i < locked) return ch;
          if (ch === " ") return " ";
          return charset[Math.floor(Math.random() * charset.length)];
        })
        .join("");
      setDisplayed(next);
      // Each tick, lock one more character from the left.
      lockedRef.current = Math.min(locked + 1, text.length);
      if (lockedRef.current >= text.length) {
        setDisplayed(text);
        clearInterval(interval);
      }
    }, speed);
    return () => clearInterval(interval);
  }, [started, text, speed, charset]);

  return <span className={className}>{displayed}</span>;
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
