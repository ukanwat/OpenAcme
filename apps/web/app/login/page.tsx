"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { API_BASE } from "../lib/api";

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
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <Lock className="h-5 w-5 text-primary" />
          </div>
          <CardTitle>OpenAcme</CardTitle>
          <CardDescription>
            Paste the access secret from <code className="rounded bg-muted px-1 py-0.5 text-xs">openacme secret</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
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
            <Button type="submit" className="w-full" disabled={submitting || !secret.trim()}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
