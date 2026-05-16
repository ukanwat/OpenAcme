# Scheduling, the Inbox, and Mid-Turn Behavior

How agents get woken up, how user messages flow when an agent is already busy, and what guarantees the system provides about message ordering and cancellation.

This document captures the **behavioral contract** — what the user can rely on, what each design choice trades for what, and which races exist. It's separate from `CLAUDE.md` (file-level guide) and `workforce-architecture.md` (conceptual framing). Read this when adding new wake triggers, new tool-bound primitives, or new chat-input affordances.

---

## 1. Two ways an agent runs a turn

**Interactive.** A human (or a script) POSTs `/api/chat`. The server marks the session interactive-busy, runs the turn via `runChatTurn`, streams the response back over SSE. One in-flight interactive turn per session.

**Autonomous.** A periodic dispatcher (60-second tick) state-checks the task board. When it finds work that needs an agent's attention, it spawns `agent.runAutonomous`. The response streams to whoever's subscribed to the session's SSE channel.

Both share `Agent.runStream` underneath. The split is at the entry path — who decides to run a turn, and on what trigger.

There is **no third path.** No `runOnce`, no "fire one turn from the CLI." If the agent runs, it's one of these two.

---

## 2. The dispatcher: state-checking, not event-reacting

The dispatcher is a single `setInterval(60_000)` that walks the board and decides what to do. Pseudocode:

```
every 60 seconds:
  for each agent whose chain is free:
    bind any unbound ready tasks to a session
    if (inbox has rows OR in_progress task OR ready open task OR only-blocked tasks):
      spawn one turn for one session
```

This shape is deliberately picked over event-routing for two reasons:

1. **The state machine fits on a postcard.** The dispatcher reads the world, decides, acts. No "we got event X, route to handler Y, update flag Z." Echo loops, debounce, rate-limit, watchdog streaks — all the machinery the old event-driven scheduler accumulated — vanish because the dispatcher doesn't react to events. It checks state.
2. **Anti-fragility to weird timing.** Laptop sleeps for six hours, daemon restarts, clock jumps — the next tick sees the world as it is and acts. Nothing is "missed" because nothing was queued in-memory.

The 60-second floor is the autonomous-wake cadence. **It is not the user-chat latency.** Interactive turns bypass the tick entirely.

### What the dispatcher does NOT do

- Wake on every task mutation.
- Echo-filter events (no events drive wakes).
- Track which event "caused" a turn.
- Run a per-task cron arm for `start_at`. The tick reads `start_at <= now` directly.
- Maintain a heartbeat probe registry. There is no probe — the tick is the probe.

---

## 3. The inbox: one delivery channel for everything addressed to an agent

`agent_inbox` is a temporary staging table, keyed by `agent_id`. Rows have a kind (`user_message`, `system_notice`), a source (`user`, `system`), and an optional `related_session` / `related_task` for routing.

The lifecycle is **pending → drained → hard-deleted**, never "marked seen." The inbox is staging, not audit. The audit log lives in `task_events`.

Anything that should reach an agent goes through the inbox:

- **User messages sent mid-turn** — `/api/chat` writes a `user_message` row when a turn is already running. The next turn (autonomous, kicked by `clearInteractiveBusy`) drains it.
- **Task events for tasks the agent owns** — `task_assigned`, `status_changed`, `comment_added` from other actors, etc. The `agentId` on the event row is the *recipient* (the task's assignee), not the actor.
- **Echo suppression at the delivery boundary, not at emit time.** When `event.actor === event.agentId`, the delivery path drops the row. Events still emit with the honest actor for audit purposes.

### Targeting

When the dispatcher decides which of an agent's sessions to spawn, it prefers sessions referenced by an inbox row's `related_session`. Without targeting, a multi-session agent could receive a queued message in the "wrong" session and the row would sit undrained.

---

## 4. Mid-turn user messages

The case: a user is chatting with an agent. The agent is streaming a response. The user wants to add another message — interrupt, clarify, ask a follow-up.

**The textbox stays enabled while the agent is streaming.** The placeholder changes to `"Queue next message for Coder…"` and the send button's aria-label becomes `"Queue message"`. Both the **Stop** button and the **Send/Queue** button are visible — the user picks: abort the current turn, or queue for the next one.

What happens on send:

1. Client POST to `/api/chat`. The user message id is client-generated (same as a normal send).
2. Server sees `activeTurns.has(sessionId)` → does NOT abort the running turn. Writes `agent_inbox` row of kind `user_message` with the original message as the payload. Broadcasts `inbox_queued` SSE event. Returns `{ queued: true }`.
3. Client renders a chip in a floating panel above the composer: `Queued · 1 / Sent on next turn`. The chip lives in local React state, deduped by id from the SSE round-trip.
4. Current turn finishes. `clearInteractiveBusy` runs, immediately kicks the dispatcher (no 60-second wait).
5. Dispatcher sees the queued user_message, targets the row's `related_session`, spawns `runAutonomous`.
6. `runAutonomous` drains the inbox: persists each queued user_message as a real user-role chat row at the natural end of history (so the model sees `[user1, assistant1, user2]`, not `[user1, user2, assistant1]`). Broadcasts `messages_appended`.
7. Agent responds. The client's match-by-id effect drops the chip as the canonical row arrives via SSE.

### Why deferred persist

If `/api/chat` persisted the user message to chat history *immediately* when queuing, the order would be `[user1, user2, assistant1]` — the model would see its own response as the most recent turn and the queued user2 would be "stranded" between the two earlier user messages. By deferring persist until the drain, the order is `[user1, assistant1, user2]` and the agent naturally responds to the queued message.

### Why the chip lives only on the originating tab (and now everywhere)

Originally the chip was tab-local: tab 1 sees its own queue, tab 2 just sees the agent running. That was the v1 gap.

The current shape broadcasts both `inbox_queued` and `inbox_cancelled` over the session's SSE channel, so any subscribed tab renders the chip in real time. The originating tab still adds the chip optimistically (instant feedback) and dedupes when its own broadcast arrives.

---

## 5. Cancellation

The `✕` on a queued chip calls `DELETE /api/sessions/:sessionId/queued/:messageId`. The server deletes the matching `agent_inbox` row.

Three outcomes:

1. **`cancelled: 1`** — the row existed and was deleted. The dispatcher won't see it on its next pass; the message is gone. The server broadcasts `inbox_cancelled` so other tabs drop the chip.
2. **`cancelled: 0`** — the row was already drained by an autonomous turn that ran between the user clicking ✕ and the DELETE landing. The message will appear in chat history within seconds. The client surfaces a toast: *"Already processing — message will appear in chat."* No `inbox_cancelled` broadcast (it would mislead — the message is landing, not gone).
3. **Network failure** — the chip is removed optimistically, but the inbox row persists. The next turn delivers the message. Client shows a toast: *"Cancel failed — the message may still arrive."*

The user-facing rule: **a chip disappearance means the message either was cancelled or has landed in chat.** It never silently vanishes.

---

## 6. The autonomous-turn prompt

When the dispatcher spawns an agent and the inbox has rows, `runAutonomous` builds the turn's history carefully:

- **All queued user_messages for this session** are persisted as real user-role chat rows. The agent responds to them as if the user had just typed.
- **System notices** (task events from other agents, cron fires, etc.) are rendered as a single `<system-event>` user-role row with `metadata.kind = "autonomous_event"`. The web UI styles these distinctly so the human reader knows the agent was woken by a system signal, not by a chat message.
- **Continuation turns** (the agent has an `in_progress` task but no new signal) get a brief `<system-event>` saying "Autonomous turn — no new signals; scan your queue." This gives the model something to respond to (`streamText` needs a final user message).
- **Unanswered-user check** — if there's already a real user message at the tail of history that hasn't been responded to (its assistant is missing), the wake row is skipped. The model responds to that user message directly.

The intent: the agent only sees a `<system-event>` row when there's actually a system signal worth surfacing. Real user messages live in chat history as themselves.

---

## 7. Defer

The `defer_session(duration)` tool writes `sessions.defer_until = now + duration`. The dispatcher's tick honors this: a session with `defer_until` in the future is skipped during **routine** spawns. The behavior:

- **Routine tick**: defer is honored. Agent is left alone.
- **Inbox row arrives** (user message, task event for this agent): defer is bypassed. The dispatcher spawns the agent anyway.
- **Spawn actually fires**: `defer_until` is cleared. Defer is one-shot, not sticky.

The user-facing read: defer is "skip the noise, not the signal." An agent that wants to be quiet calls `defer_session("2h")` at the end of a turn; if anything real happens before then, the agent wakes.

`defer_session("never")` is rejected at parse time — the old `sleep("never")` was a fiction (silently clamped to 24h). Ceiling is 24h; agents can't permanently silence themselves.

---

## 8. Constraints at the write boundary

The store enforces invariants and surfaces them as actionable tool errors:

- **At most one task `in_progress` per session.** Try to claim a second → `session_busy: Session X already has an in_progress task (Y)`.
- **`task_update(in_progress)` with unmet deps** → `deps_unsatisfied: Cannot start task Z: not all dependencies are done`.
- **Cycles in `depends_on`** → rejected at write time via DFS.
- **Status transitions to terminal states (`done`/`canceled`)** — once set, they stick (no flip back via auto-correct).

The prompt explains these rules so the agent knows them upfront. The store enforces them so the agent learns by trying.

**Reads are unrestricted.** The agent can see every task, every comment, every event in the system. Hiding things creates blind spots and weird workarounds. The friction is at the *action*, not the *view*.

---

## 9. Dependencies are read-time predicates

A task with unmet `depends_on` is stored as `open` (or `todo`), not auto-flipped to `blocked`. The dispatcher's readiness predicate filters tasks live on each tick:

```
ready =  status = "open"
      AND (start_at IS NULL OR start_at <= now)
      AND all depends_on are done
```

When a dep closes, the dispatcher's next tick (or next event-driven tick from `clearInteractiveBusy`) re-evaluates and the dependent task becomes ready. No `dep_unblocked` event is emitted to the inbox.

`blocked` is **explicit-only**: an agent or human set it. Reasons sit in a `system:scheduler` comment when the dispatcher's failure-park path sets it (turn timed out, errored, etc.).

---

## 10. Failure modes

What happens when things go wrong:

- **Daemon crash mid-turn**: stale `in_progress` tasks are reset to `open` on startup (`taskStore.sweepStale`). Queued inbox rows persist in SQLite — the next tick drains them.
- **Agent definition deleted but sessions exist**: warned once per process, then silently skipped. No spawn attempts for orphan agents.
- **Inbox row addressed to an agent that no longer exists**: same — dispatcher logs once, drops the wake.
- **Multiple inbox rows pile up over time**: the autonomous turn drains them in one drain pass. The cap on mid-turn drain injections (5/turn) prevents pathological cases.
- **Agent ends a turn with no action**: the dispatcher's no-claim watchdog (1-strike threshold) parks the head-of-queue task with a `system:scheduler` comment so it doesn't loop. The agent's `defer_session` is the agent-side opt-out for "I have nothing to do and don't want to be woken every 60s."
- **Two tabs send the same `messageId`**: deduped at the inbox level (insertion is idempotent on the row's auto-increment id, but the source_id might collide; the dispatcher drains by row id so a duplicate sender's second POST would just queue twice as separate rows — not currently a tested edge case).

---

## 11. What the user can rely on

Reading the system top-down, the guarantees are:

1. **A user message you send always either reaches the chat or surfaces a visible "couldn't cancel" / "still processing" toast.** It never silently disappears.
2. **A queued chip's disappearance means one of**: (a) cancelled — message gone, (b) drained — message now in chat history.
3. **The agent will respond to a queued message** unless: you cancelled it before drain, OR an explicit error path failed (toast appears).
4. **The agent's response order matches the order you sent messages** — message N's assistant always comes after message N-1's.
5. **The agent will not be woken by its own actions.** Echo suppression at delivery prevents the runaway-loop pattern the old event-driven scheduler suffered.
6. **Constraint violations surface as actionable tool errors**, never silent rejection or auto-correction.

These are the contract. Everything else (60-second tick, inbox table, SSE event names, `defer_until` column) is implementation detail that could change without breaking the contract.

---

## 12. Surfaces worth knowing

| Concept | Implementation |
|---|---|
| Dispatcher | `packages/server/src/dispatcher.ts` |
| Per-agent inbox | `packages/db/src/stores/inbox-store.ts` + `agent_inbox` table |
| Inbox emit fan-out (with echo suppression) | `AgentManager.eventStore.onEmit` in `packages/server/src/agent-manager.ts` |
| Mid-turn queue path | `/api/chat` in `packages/server/src/app.ts` (the `inFlight` branch) |
| Wake-row decision | `Agent.runAutonomous` in `packages/agent-core/src/agent.ts` (the `inboxText` / `drainedUserMessage` / `unansweredUser` triplet) |
| Defer tool | `packages/tools/src/builtins/defer-session.ts`; column `sessions.defer_until` |
| SSE events | `packages/server/src/broadcaster.ts` `SessionBroadcastEvent` union |
| Queue UI panel | `apps/web/app/page.tsx` `queuedMessages` state + the `Queued · N` panel above the composer |
| Cancel route | `DELETE /api/sessions/:sessionId/queued/:messageId` in `packages/server/src/app.ts` |

If you add a new wake trigger, new SSE event, or new chat-input affordance, this doc should grow to cover it.
