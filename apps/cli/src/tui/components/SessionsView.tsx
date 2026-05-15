import { Box, Text, useApp, useInput } from "ink";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import type { AgentManager } from "@openacme/server";
import {
  buildHomePayload,
  type HomePayload,
  type SessionSummary,
} from "@openacme/server";

/**
 * Full-screen sessions landing — mirrors the web home page (Waiting /
 * Running / Idle) with a single flat cursor across all three buckets.
 * Live-updates via the workforce broadcaster (no polling).
 *
 * Windowed: only `PAGE_SIZE` rows render at a time, with "↑ N more
 * above" / "↓ N more below" markers. As ↑/↓ moves the cursor past the
 * window edge, the window slides — same pattern as PickerList.
 */
const PAGE_SIZE = 14;

type Bucket = "waiting" | "running" | "idle";

interface FlatRow {
  bucket: Bucket;
  s: SessionSummary;
}

export function SessionsView({
  manager,
  initialSessionId,
  inputDisabled,
  onOpen,
  onNewChat,
}: {
  manager: AgentManager;
  initialSessionId?: string;
  inputDisabled: boolean;
  onOpen: (sessionId: string) => void;
  onNewChat: () => void;
}) {
  const inkApp = useApp();
  const [payload, setPayload] = useState<HomePayload | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(
    initialSessionId ?? null
  );

  // Debounce 100ms so a burst of events (e.g. an autonomous turn that
  // touches 5 tasks) coalesces to one refetch.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetch = useCallback(() => {
    try {
      setPayload(buildHomePayload(manager));
    } catch {
      // Snapshot read failed; will retry on next event.
    }
  }, [manager]);
  useEffect(() => {
    refetch();
    const unsub = manager.broadcaster.subscribeWorkforce(() => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(refetch, 100);
    });
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      unsub();
    };
  }, [manager, refetch]);

  // Flat ordered list across buckets — the cursor walks the visible
  // rows in display order so ↑/↓ feels natural across section breaks.
  const rows = useMemo<FlatRow[]>(() => {
    if (!payload) return [];
    return [
      ...payload.waiting.map((s) => ({ bucket: "waiting" as Bucket, s })),
      ...payload.running.map((s) => ({ bucket: "running" as Bucket, s })),
      ...payload.idle.map((s) => ({ bucket: "idle" as Bucket, s })),
    ];
  }, [payload]);

  // Cursor tracks `sessionId` — refreshes that reorder rows shouldn't
  // make the highlight jump to a different session.
  useEffect(() => {
    if (rows.length === 0) return;
    if (cursorId && rows.some((r) => r.s.sessionId === cursorId)) return;
    setCursorId(rows[0]!.s.sessionId);
  }, [rows, cursorId]);

  const cursorIndex = rows.findIndex((r) => r.s.sessionId === cursorId);

  // Sliding window — same shape as PickerList. Keep the cursor inside
  // a band centered on it (half before, half after); clamp to bounds.
  const windowStart = useMemo(() => {
    if (rows.length <= PAGE_SIZE) return 0;
    if (cursorIndex < 0) return 0;
    const half = Math.floor(PAGE_SIZE / 2);
    const desired = cursorIndex - half;
    const max = rows.length - PAGE_SIZE;
    return Math.max(0, Math.min(desired, max));
  }, [cursorIndex, rows.length]);
  const windowEnd = Math.min(rows.length, windowStart + PAGE_SIZE);
  const hiddenAbove = windowStart;
  const hiddenBelow = rows.length - windowEnd;
  const visibleRows = rows.slice(windowStart, windowEnd);

  useInput(
    (input, key) => {
      if (rows.length === 0) {
        if (input === "n" || input === "N") onNewChat();
        if (input === "q" || input === "Q") inkApp.exit();
        return;
      }
      if (key.upArrow) {
        const next = cursorIndex <= 0 ? rows.length - 1 : cursorIndex - 1;
        setCursorId(rows[next]!.s.sessionId);
        return;
      }
      if (key.downArrow) {
        const next =
          cursorIndex >= rows.length - 1 ? 0 : cursorIndex + 1;
        setCursorId(rows[next]!.s.sessionId);
        return;
      }
      if (key.pageUp) {
        const next = Math.max(0, cursorIndex - PAGE_SIZE);
        setCursorId(rows[next]!.s.sessionId);
        return;
      }
      if (key.pageDown) {
        const next = Math.min(rows.length - 1, cursorIndex + PAGE_SIZE);
        setCursorId(rows[next]!.s.sessionId);
        return;
      }
      if (key.return) {
        if (cursorIndex < 0) return;
        onOpen(rows[cursorIndex]!.s.sessionId);
        return;
      }
      if (input === "n" || input === "N") {
        onNewChat();
        return;
      }
      if (input === "q" || input === "Q") {
        inkApp.exit();
        return;
      }
    },
    { isActive: !inputDisabled }
  );

  if (!payload) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text dimColor>Loading sessions…</Text>
      </Box>
    );
  }

  const total =
    payload.waiting.length + payload.running.length + payload.idle.length;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>Sessions</Text>
        <Text dimColor>
          {`  ·  ${payload.waiting.length} waiting · ${payload.running.length} running · ${payload.idle.length} idle`}
        </Text>
      </Box>

      {total === 0 ? (
        <Box flexDirection="column">
          <Text>No sessions yet.</Text>
          <Text dimColor>Press n to start one.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {hiddenAbove > 0 && (
            <Text dimColor>{`↑ ${hiddenAbove} more above`}</Text>
          )}
          {renderRows(visibleRows, cursorId)}
          {hiddenBelow > 0 && (
            <Text dimColor>{`↓ ${hiddenBelow} more below`}</Text>
          )}
          <Box marginTop={1}>
            <Text dimColor>{`${cursorIndex >= 0 ? cursorIndex + 1 : 0} / ${rows.length}`}</Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ select · PgUp/PgDn page · enter open · n new · q quit
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Walk the windowed rows in order; emit a section header element
 * before the first row of each bucket that appears in the window so a
 * partial scroll still labels the visible group correctly.
 */
function renderRows(visible: FlatRow[], cursorId: string | null) {
  const out: React.ReactNode[] = [];
  let lastBucket: Bucket | null = null;
  for (let i = 0; i < visible.length; i++) {
    const row = visible[i]!;
    if (row.bucket !== lastBucket) {
      out.push(
        <Text dimColor key={`h-${row.bucket}-${i}`}>
          {labelFor(row.bucket)}
        </Text>
      );
      lastBucket = row.bucket;
    }
    out.push(
      <Row
        key={row.s.sessionId}
        bucket={row.bucket}
        session={row.s}
        active={row.s.sessionId === cursorId}
      />
    );
  }
  return out;
}

function labelFor(b: Bucket): string {
  if (b === "waiting") return "WAITING";
  if (b === "running") return "RUNNING";
  return "IDLE";
}

function Row({
  bucket,
  session,
  active,
}: {
  bucket: Bucket;
  session: SessionSummary;
  active: boolean;
}) {
  const dot = bucket === "idle" ? "◯" : "●";
  const dotColor =
    bucket === "waiting"
      ? "red"
      : bucket === "running"
        ? "green"
        : "gray";
  const summary =
    bucket === "waiting" && session.pingMessage
      ? truncate(session.pingMessage, 60)
      : bucket === "running" && session.currentTaskTitle
        ? truncate(session.currentTaskTitle, 60)
        : truncate(session.title ?? "(untitled)", 60);
  return (
    <Box>
      <Text color={active ? "cyan" : undefined} bold={active}>
        {active ? "▸ " : "  "}
      </Text>
      <Text color={dotColor}>{dot}</Text>
      <Text> </Text>
      <Text bold>{session.agentName}</Text>
      <Text dimColor> · </Text>
      <Text>{summary}</Text>
      <Text dimColor>{`  ${relativeTime(session.lastActivity)}`}</Text>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function relativeTime(unixSec: number): string {
  const diff = Math.max(0, Date.now() / 1000 - unixSec);
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
