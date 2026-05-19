"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { ScribedRule } from "@/app/components/ui/scribed-rule";
import { Logotype } from "@/app/components/Logotype";
import { API_BASE } from "../lib/api";

const HEADLINE = "OPENACME · DAEMON READY";

export default function LoginPage() {
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [next, setNext] = useState("/");

  useEffect(() => {
    // Pull the `next` param if present so we redirect back where the
    // browser was originally heading. Default to `/` (chat home).
    const params = new URLSearchParams(window.location.search);
    const n = params.get("next");
    if (n) setNext(n);

    // If auth isn't required (loopback), skip the form entirely.
    fetch(`${API_BASE}/api/auth/status`, { credentials: "include" })
      .then((r) => r.json())
      .then((data: { authRequired?: boolean }) => {
        if (data && data.authRequired === false) {
          window.location.href = n || "/";
        }
      })
      .catch(() => undefined);
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!secret.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: secret.trim() }),
      });
      if (!res.ok) {
        let message = "Login failed";
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // keep default message
        }
        toast.error(message);
        setSubmitting(false);
        return;
      }
      window.location.href = next || "/";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <main className="paper-surface relative flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="section-enter w-full max-w-sm border border-paper-rule bg-paper">
        <ScribedRule className="bg-ink" />

        <div className="px-5 pt-4 pb-3">
          <Logotype className="h-7 w-auto text-ink" />
          <h1 className="scribe-in mt-3 font-mono text-[11px] uppercase tracking-[0.08em] text-ink">
            {HEADLINE}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Paste the access secret from{" "}
            <code className="px-1 py-0.5 font-mono text-[11px] text-ink">
              openacme secret
            </code>
            .
          </p>
        </div>

        <ScribedRule delay={300} />

        <form onSubmit={onSubmit} className="space-y-4 px-5 py-4">
          <div className="space-y-2">
            <Label htmlFor="secret">Secret</Label>
            <Input
              id="secret"
              type="password"
              autoFocus
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={submitting}
            />
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !secret.trim()}
          >
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <LoadingHairline inline aria-label="Verifying" />
                Verifying
              </span>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>
      </div>
    </main>
  );
}
