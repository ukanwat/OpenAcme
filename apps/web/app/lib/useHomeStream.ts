"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";
import type { HomePayload } from "./types";

/**
 * Live workforce summary for the home page. Fetches the initial
 * snapshot from `GET /api/home`, then subscribes to `GET
 * /api/home/stream` for deltas. The stream is the source of truth
 * for "something changed somewhere" — on receiving any envelope, we
 * refetch the snapshot. This is intentionally simple: the snapshot
 * is cheap (one DB query plus filesystem walk for tasks) and the
 * alternative — applying incremental deltas client-side — would
 * duplicate the server's grouping/sort logic in TS.
 *
 * Coalesces bursts: an inbound envelope schedules a refetch on the
 * next animation frame; a second envelope arriving in the same frame
 * doesn't trigger a second refetch. Keeps the home view smooth under
 * heavy autonomous activity.
 */
export function useHomeStream(): {
  payload: HomePayload | null;
  loading: boolean;
  error: string | null;
  refresh: (opts?: { force?: boolean }) => Promise<void>;
} {
  const [payload, setPayload] = useState<HomePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refetchScheduled = useRef(false);

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/home`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HomePayload;
      setPayload(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(
    async (opts?: { force?: boolean }) => {
      // Forced refresh (after a user action — delete, etc.) skips the
      // animation-frame coalescer so the UI reflects the change next paint
      // instead of waiting for the next SSE-driven cycle. Without `force`,
      // an in-flight SSE refresh that started BEFORE the action returns
      // stale data and the deleted row sticks around until the next event.
      if (opts?.force) {
        await fetchSnapshot();
        return;
      }
      if (refetchScheduled.current) return;
      refetchScheduled.current = true;
      requestAnimationFrame(() => {
        refetchScheduled.current = false;
        void fetchSnapshot();
      });
    },
    [fetchSnapshot]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/home/stream`, {
      withCredentials: true,
    });
    const onAny = () => refresh();
    es.addEventListener("session_state", onAny);
    es.addEventListener("task_event", onAny);
    // ui_message_part is per-token noise — don't refetch on each.
    return () => {
      es.removeEventListener("session_state", onAny);
      es.removeEventListener("task_event", onAny);
      es.close();
    };
  }, [refresh]);

  return { payload, loading, error, refresh };
}
