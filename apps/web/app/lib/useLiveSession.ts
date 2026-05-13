"use client";

import { useEffect, useRef, useState } from "react";
import { readUIMessageStream } from "ai";
import type { OpenAcmeUIMessage } from "./types";
import { API_BASE } from "./api";

/**
 * Subscribe to a per-session SSE channel; feed `ui_message_part`
 * chunks into `readUIMessageStream` for live assembly and accept
 * pre-assembled UIMessages via `messages_appended`. Both paths
 * upsert into `setMessages` by id, so the same message arriving via
 * the originating tab's useChat response AND the SSE echo converges
 * to one row.
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
  }
): { state: "running" | "idle" } {
  const [state, setState] = useState<"running" | "idle">("idle");
  // Latest opts via ref so the SSE handlers aren't part of the
  // resubscribe key (only sessionId is).
  const setMessagesRef = useRef(setMessages);
  const onTaskEventRef = useRef(opts?.onTaskEvent);
  useEffect(() => {
    setMessagesRef.current = setMessages;
    onTaskEventRef.current = opts?.onTaskEvent;
  });

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(
      `${API_BASE}/api/sessions/${sessionId}/stream`,
      { withCredentials: true }
    );

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
          if (env.part !== undefined) controller?.enqueue(env.part);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return { state };
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
