"use client";

import { useEffect, useRef, useState } from "react";
import { readUIMessageStream } from "ai";
import type { OpenAcmeUIMessage } from "./types";
import { API_BASE } from "./api";

/**
 * Subscribe to a per-session SSE channel. Feeds `ui_message_part` chunks
 * into `readUIMessageStream` for live assembly; accepts pre-assembled
 * UIMessages via `messages_appended`. Both upsert by id so chunks and
 * the end-of-turn canonical broadcast converge.
 *
 * `whenConnected()` resolves on the EventSource's `open` event for the
 * current sessionId — callers await it before posting /api/chat so the
 * agent's first chunks aren't missed.
 */
export function useLiveSession(
  sessionId: string | null | undefined,
  setMessages:
    | ((updater: (prev: OpenAcmeUIMessage[]) => OpenAcmeUIMessage[]) => void)
    | null,
  opts?: {
    onTaskEvent?: (event: {
      id: string;
      kind: string;
      taskId: string | null;
      payload: string | null;
    }) => void;
    /** Transient data-* parts are stripped by the assembler, surfaced
     *  here instead. */
    onDataPart?: (part: { type: string; data: unknown }) => void;
  }
): { state: "running" | "idle"; whenConnected: () => Promise<void> } {
  const [state, setState] = useState<"running" | "idle">("idle");
  // Latest opts via ref so the SSE handlers aren't part of the
  // resubscribe key (only sessionId is).
  const setMessagesRef = useRef(setMessages);
  const onTaskEventRef = useRef(opts?.onTaskEvent);
  const onDataPartRef = useRef(opts?.onDataPart);
  setMessagesRef.current = setMessages;
  onTaskEventRef.current = opts?.onTaskEvent;
  onDataPartRef.current = opts?.onDataPart;
  // Promise that resolves on the current EventSource's `open`. Replaced
  // on every sessionId change so callers always await the live one.
  const connectedRef = useRef<{ promise: Promise<void>; resolve: () => void }>(
    (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    })()
  );
  const whenConnected = () => connectedRef.current.promise;

  useEffect(() => {
    if (!sessionId) return;
    let resolveConnected!: () => void;
    connectedRef.current = {
      promise: new Promise<void>((r) => (resolveConnected = r)),
      resolve: () => resolveConnected(),
    };
    const es = new EventSource(
      `${API_BASE}/api/sessions/${sessionId}/stream`,
      { withCredentials: true }
    );
    es.onopen = () => resolveConnected();

    // Feed `readUIMessageStream` via a manually-controlled
    // ReadableStream. SSE handlers enqueue chunks; the assembler
    // pulls and yields UIMessages as they assemble.
    let controller: ReadableStreamDefaultController<unknown> | null = null;
    const stream = new ReadableStream<unknown>({
      start(c) {
        controller = c;
      },
    });
    void (async () => {
      try {
        for await (const message of readUIMessageStream<OpenAcmeUIMessage>({
          stream: stream as ReadableStream<never>,
        })) {
          // Late-joining subscribers miss the `start` chunk (SSE doesn't
          // replay on fresh connect), so the assembler emits with an
          // empty-string id. Drop those — `messages_appended` for the
          // real id will arrive at the end of the turn.
          if (!message.id) continue;
          setMessagesRef.current?.((prev) => upsertById(prev, message));
        }
      } catch {
        // Stream closed on session change — expected.
      }
    })();

    const handlers: Record<string, (e: MessageEvent) => void> = {
      ui_message_part: (e) => {
        try {
          const env = JSON.parse(e.data) as { part?: unknown };
          if (env.part === undefined) return;
          const part = env.part as { type?: unknown; data?: unknown };
          if (
            typeof part.type === "string" &&
            part.type.startsWith("data-") &&
            part.data !== undefined
          ) {
            try {
              onDataPartRef.current?.({
                type: part.type,
                data: part.data,
              });
            } catch {
              /* surface-only; never break assembly */
            }
          }
          controller?.enqueue(env.part);
        } catch {
          /* ignore */
        }
      },
      messages_appended: (e) => {
        try {
          const env = JSON.parse(e.data) as { messages?: OpenAcmeUIMessage[] };
          if (!env.messages?.length) return;
          setMessagesRef.current?.((prev) => {
            let out = prev;
            for (const m of env.messages!) out = upsertById(out, m);
            return out;
          });
        } catch {
          /* ignore */
        }
      },
      session_state: (e) => {
        try {
          const env = JSON.parse(e.data) as { state?: "running" | "idle" };
          if (env.state === "running" || env.state === "idle") {
            setState(env.state);
          }
        } catch {
          /* ignore */
        }
      },
      task_event: (e) => {
        try {
          const env = JSON.parse(e.data) as {
            event?: {
              id: string;
              kind: string;
              taskId: string | null;
              payload: string | null;
            };
          };
          if (env.event) onTaskEventRef.current?.(env.event);
        } catch {
          /* ignore */
        }
      },
    };
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, fn);
    }

    return () => {
      for (const [name, fn] of Object.entries(handlers)) {
        es.removeEventListener(name, fn);
      }
      es.close();
      try {
        controller?.close();
      } catch {
        /* already closed */
      }
    };
  }, [sessionId]);

  return { state, whenConnected };
}

function upsertById(
  prev: OpenAcmeUIMessage[],
  next: OpenAcmeUIMessage
): OpenAcmeUIMessage[] {
  const idx = prev.findIndex((m) => m.id === next.id);
  if (idx < 0) return [...prev, next];
  const out = prev.slice();
  out[idx] = next;
  return out;
}
