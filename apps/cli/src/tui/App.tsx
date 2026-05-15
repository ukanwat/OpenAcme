import { Box, Text, useApp, useInput } from "ink";
import { useReducer, useState, useMemo, useCallback, useRef, useEffect } from "react";
import { randomUUID } from "node:crypto";
import type { AgentManager } from "@openacme/server";
import type { AgentDefinition, ModelConfig } from "@openacme/config";
import { detectProviderCredentials } from "@openacme/llm-provider";
import {
  ensureStepBoundaries,
  finalizeOrphanToolParts,
  sanitizeStoredHistory,
  type UIMessage,
} from "@openacme/agent-core";
import { reducer, initState, type PendingAttachment } from "./state.js";
import { COMMANDS, findCommand, filterCommands, type CommandCtx } from "./commands.js";
import { MessageList } from "./components/MessageList.js";
import { StatusLine } from "./components/StatusLine.js";
import { MultilineInput } from "./components/MultilineInput.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { AgentPicker } from "./components/AgentPicker.js";
import { SessionPicker, type SessionRow } from "./components/SessionPicker.js";
import { SkillsOverlay } from "./components/SkillsOverlay.js";
import { MCPOverlay } from "./components/MCPOverlay.js";
import { TasksOverlay } from "./components/TasksOverlay.js";
import { PendingAttachmentsBar } from "./components/PendingAttachmentsBar.js";
import { FilePathPicker } from "./components/FilePathPicker.js";
import {
  detectAtQuery,
  listProjectFiles,
  makeRanker,
  replaceAtToken,
  stripAtToken,
} from "./file-search.js";
import { dbMessagesToTuiMessages } from "./restore.js";
import {
  commitAttachmentForCli,
  extractAtPaths,
  loadAttachment,
  looksLikeDroppedPath,
} from "./attachments.js";

/** Agent def with `model` already resolved against the root config.
 *  All callers pass agents from `manager.listAgents()` / `getAgentDef()`
 *  which guarantee the model is set. */
type ResolvedAgent = AgentDefinition & { model: ModelConfig };

interface Props {
  manager: AgentManager;
  agent: ResolvedAgent;
  dataDir: string;
}

function buildAssistantMessage(
  id: string,
  parts: UIMessage["parts"]
): UIMessage | null {
  if (parts.length === 0) return null;
  return {
    id,
    role: "assistant",
    parts: ensureStepBoundaries(finalizeOrphanToolParts(parts)),
  } as UIMessage;
}

export function App({ manager, agent, dataDir }: Props) {
  const inkApp = useApp();
  const [state, dispatch] = useReducer(
    reducer,
    {
      agentId: agent.id,
      agentName: agent.name,
      modelLabel: `${agent.model.provider}/${agent.model.model}`,
      sessionId: cryptoId(),
    },
    initState
  );
  const [input, setInput] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const sendingRef = useRef(false);
  // AbortController for the in-flight turn. Created per `sendTurn`,
  // nulled in `finally`. `useInput` below calls `.abort()` on Esc when
  // status === "streaming"; the agent yields `stopped` and the loop ends.
  const abortRef = useRef<AbortController | null>(null);

  const exit = useCallback(() => {
    inkApp.exit();
  }, [inkApp]);

  const ctx: CommandCtx = useMemo(
    () => ({ dispatch, manager, agentId: state.agentId, exit }),
    [manager, state.agentId, exit]
  );

  const configuredProviders = useMemo(
    () => detectProviderCredentials(dataDir).configured,
    [dataDir]
  );

  // ── Send a turn ────────────────────────────────────────────────────────
  const sendTurn = useCallback(
    async (text: string, attachments: PendingAttachment[]) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Commit each pending attachment to disk and build a UIMessage with
      // text + file parts. The CLI runs in-process and writes straight
      // under the session's attachments dir — no upload route involved.
      const fileParts = attachments.map((p) =>
        commitAttachmentForCli(manager.attachmentsRoot, state.sessionId, p)
      );
      const userMsg: UIMessage = {
        id: randomUUID(),
        role: "user",
        parts: [
          ...(text ? [{ type: "text", text } as UIMessage["parts"][number]] : []),
          ...(fileParts as UIMessage["parts"]),
        ],
      } as UIMessage;
      dispatch({ type: "user-submit", message: userMsg });
      const assistantId = randomUUID();
      dispatch({ type: "stream-start", assistantId });

      // Hoisted so the catch block can finalize and persist whatever
      // parts streamed before an abort or error.
      const assistantParts: UIMessage["parts"] = [];

      try {
        // Ensure the session row exists before runStream — `getSystemPrompt`
        // updates it, and the message-append at the end has an FK to it.
        if (!manager.sessionStore.get(state.sessionId)) {
          manager.sessionStore.create(state.agentId, { id: state.sessionId });
        }
        const agent = manager.getAgent(state.agentId);
        const history: UIMessage[] = [...state.committed, userMsg];
        const result = await agent.runStream({
          sessionId: state.sessionId,
          history,
          signal: ctrl.signal,
        });

        // Assemble the canonical assistant UIMessage from fullStream as we
        // also dispatch incremental updates to the reducer for live render.
        let textBuf = "";
        const flushText = () => {
          if (!textBuf) return;
          assistantParts.push({
            type: "text",
            text: textBuf,
          } as UIMessage["parts"][number]);
          textBuf = "";
        };

        for await (const part of result.fullStream) {
          const tp = part as { type?: string };
          switch (tp.type) {
            case "start-step": {
              // Persist the step boundary so a multi-step turn (text →
              // tool → text) round-trips through `convertToModelMessages`
              // as separate model messages. Without this, the post-tool
              // text and pre-tool text collapse into one assistant block
              // and Anthropic rejects with `tool_use ... without
              // tool_result blocks immediately after`.
              flushText();
              assistantParts.push({
                type: "step-start",
              } as unknown as UIMessage["parts"][number]);
              break;
            }
            case "text-delta": {
              const text = (part as { text?: string }).text ?? "";
              if (text) {
                textBuf += text;
                dispatch({ type: "stream-text-delta", text });
              }
              break;
            }
            case "tool-input-start": {
              flushText();
              const tc = part as {
                id?: string;
                toolCallId?: string;
                toolName: string;
              };
              dispatch({
                type: "stream-tool-input-start",
                toolCallId: tc.toolCallId ?? tc.id ?? randomUUID(),
                toolName: tc.toolName,
              });
              break;
            }
            case "tool-call": {
              flushText();
              const tc = part as {
                toolCallId: string;
                toolName: string;
                input: unknown;
              };
              dispatch({
                type: "stream-tool-call",
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                input: tc.input,
              });
              assistantParts.push({
                type: `tool-${tc.toolName}`,
                toolCallId: tc.toolCallId,
                state: "input-available",
                input: tc.input,
              } as unknown as UIMessage["parts"][number]);
              break;
            }
            case "tool-result": {
              const tr = part as { toolCallId: string; output: unknown };
              dispatch({
                type: "stream-tool-result",
                toolCallId: tr.toolCallId,
                output: tr.output,
              });
              const idx = assistantParts.findIndex(
                (p) =>
                  (p as { toolCallId?: string }).toolCallId === tr.toolCallId
              );
              if (idx !== -1) {
                assistantParts[idx] = {
                  ...(assistantParts[idx] as object),
                  state: "output-available",
                  output: tr.output,
                } as UIMessage["parts"][number];
              }
              break;
            }
            case "error": {
              flushText();
              const err = (part as { error?: unknown }).error;
              dispatch({
                type: "stream-error",
                error: err instanceof Error ? err.message : String(err),
              });
              break;
            }
            default:
              break;
          }
        }
        flushText();

        const usage = await result.usage;
        const responseMessage = buildAssistantMessage(assistantId, assistantParts);

        // Persist the user msg + assembled response to the session.
        manager.messageStore.append(state.sessionId, {
          id: userMsg.id,
          role: "user",
          parts: userMsg.parts as unknown[],
        });
        if (responseMessage) {
          manager.messageStore.append(state.sessionId, {
            id: assistantId,
            role: "assistant",
            parts: responseMessage.parts as unknown[],
          });
        }

        dispatch({
          type: "stream-done",
          responseMessage,
          usage: usage ?? undefined,
        });
      } catch (err) {
        const aborted = (err as Error)?.name === "AbortError";
        // On abort, finalize any orphan tool parts so the next turn's
        // history stays valid for the provider, then persist + commit
        // the partial assistant.
        const partial = buildAssistantMessage(assistantId, assistantParts);
        if (partial) {
          manager.messageStore.append(state.sessionId, {
            id: userMsg.id,
            role: "user",
            parts: userMsg.parts as unknown[],
          });
          manager.messageStore.append(state.sessionId, {
            id: assistantId,
            role: "assistant",
            parts: partial.parts as unknown[],
          });
        }
        if (!aborted) {
          dispatch({
            type: "stream-error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        dispatch({ type: "stream-done", responseMessage: partial });
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
        sendingRef.current = false;
      }
    },
    [manager, state.agentId, state.sessionId, state.committed]
  );

  // Resolve a raw path (drag-drop or @<path>) to an attachment and stage
  // it in pendingAttachments. Surfaces a one-shot notice on failure.
  const tryAttachPath = useCallback((rawPath: string) => {
    const result = loadAttachment(rawPath);
    if (typeof result === "string") {
      dispatch({ type: "attach-notice", message: result });
      return false;
    }
    dispatch({ type: "attach-add", attachment: result });
    return true;
  }, []);

  // Esc-to-stop while streaming. Lives at the App level rather than inside
  // MultilineInput because that input is `disabled` mid-stream, which gates
  // its own useInput. Multiple Ink useInput hooks coexist fine.
  useInput((input, key) => {
    if (key.escape && state.status === "streaming") {
      abortRef.current?.abort();
    }
    // Ctrl+X clears the pending attachment list.
    if (key.ctrl && input === "x" && state.pendingAttachments.length > 0) {
      dispatch({ type: "attach-clear" });
    }
  });

  // ── Slash command dispatch ─────────────────────────────────────────────
  const runSlashCommand = useCallback(
    async (raw: string) => {
      const cmd = findCommand(raw);
      if (!cmd) {
        // Unknown command; surface as an inline error notice.
        dispatch({
          type: "stream-error",
          error: `Unknown command: ${raw.split(/\s+/)[0]}. Type /help.`,
        });
        return;
      }
      const args = raw.replace(/^\s*\/\S+\s*/, "");
      await cmd.handler(ctx, args);
    },
    [ctx]
  );

  // ── Palette state ──────────────────────────────────────────────────────
  const paletteOpen =
    input.startsWith("/") &&
    !state.modelPickerOpen &&
    !state.agentPickerOpen &&
    !state.sessionPickerOpen &&
    !state.skillsOverlayOpen &&
    !state.mcpOverlayOpen &&
    !state.tasksOverlayOpen;
  const matches = paletteOpen ? filterCommands(input) : [];

  // ── @-fuzzy file picker state ──────────────────────────────────────────
  // File index is built once at mount via globby (respects .gitignore).
  // The fzf matcher is rebuilt only when the index changes — fzf itself
  // does limit-bounded scoring per query so re-running it on every
  // keystroke is cheap.
  const [ranker, setRanker] = useState<((q: string) => string[]) | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listProjectFiles(process.cwd()).then((files) => {
      if (cancelled) return;
      setRanker(() => makeRanker(files, process.cwd(), 10));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const atQuery = useMemo(() => detectAtQuery(input), [input]);
  const atPickerOpen =
    atQuery !== null &&
    !paletteOpen &&
    !state.modelPickerOpen &&
    !state.agentPickerOpen &&
    !state.sessionPickerOpen &&
    !state.skillsOverlayOpen &&
    !state.mcpOverlayOpen &&
    !state.tasksOverlayOpen;
  const atMatches = useMemo(
    () => (atPickerOpen && ranker ? ranker(atQuery!) : []),
    [atPickerOpen, ranker, atQuery]
  );
  const [atIndex, setAtIndex] = useState(0);
  // Reset selection whenever the query changes.
  useEffect(() => {
    setAtIndex(0);
  }, [atQuery]);

  // Accept the highlighted match. For attachment-eligible files (PNG /
  // JPEG / WebP / GIF / PDF, under MAX_FILE_BYTES) we commit straight to
  // the pending list and strip the @-token from input — the user wanted
  // to attach, not paste a path. For everything else we insert the path
  // text so the model can read or reference the file via tools.
  const acceptAtMatch = useCallback(() => {
    if (!atPickerOpen || atMatches.length === 0) return false;
    const chosen = atMatches[Math.min(atIndex, atMatches.length - 1)];
    if (!chosen) return false;
    const result = loadAttachment(chosen);
    if (typeof result !== "string") {
      dispatch({ type: "attach-add", attachment: result });
      setInput((prev) => stripAtToken(prev));
      return true;
    }
    setInput((prev) => replaceAtToken(prev, chosen));
    return true;
  }, [atPickerOpen, atMatches, atIndex]);

  // ── Submit ─────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;

      // Palette pick: when the palette is showing matches for a partial
      // slash input (e.g. "/age"), Enter selects the highlighted entry
      // rather than submitting the literal partial that findCommand can't
      // resolve. Falls through to literal submission only when there are
      // no matches.
      if (paletteOpen && matches.length > 0) {
        const chosen = matches[Math.min(paletteIndex, matches.length - 1)];
        if (chosen) {
          setInput("");
          setPaletteIndex(0);
          void runSlashCommand(`/${chosen.name}`);
          return;
        }
      }

      // @-picker pick: Enter while the popup is open inserts the
      // highlighted match instead of submitting the buffer.
      if (atPickerOpen && atMatches.length > 0) {
        if (acceptAtMatch()) return;
      }

      setInput("");
      setPaletteIndex(0);

      // Drag-drop fallback. Some terminals deliver the dropped path in
      // multiple stdin reads; MultilineInput's one-shot detector requires
      // the whole path in a single useInput call. If the entire buffer
      // is just a path to a real file, treat it as drag-drop regardless
      // of how it arrived. Must precede the slash-command branch — an
      // absolute path also starts with "/". tryAttachPath surfaces its
      // own notice on unsupported-MIME / too-large; we bail either way
      // so the path doesn't get sent to the model as a chat message.
      if (looksLikeDroppedPath(text)) {
        tryAttachPath(text);
        return;
      }

      if (text.startsWith("/")) {
        void runSlashCommand(text);
        return;
      }

      // Extract `@<path>` tokens from the message text. Each resolved
      // path becomes an attachment; the cleaned text drops the tokens.
      // Unresolved paths surface as a one-shot notice and stay in the
      // text so the user can fix them and re-send.
      const { cleaned, paths } = extractAtPaths(text);
      const inlineAttachments: PendingAttachment[] = [];
      const failed: string[] = [];
      for (const p of paths) {
        const result = loadAttachment(p);
        if (typeof result === "string") failed.push(p);
        else inlineAttachments.push(result);
      }
      const attachments = [...state.pendingAttachments, ...inlineAttachments];
      const finalText = inlineAttachments.length > 0 ? cleaned : text;

      if (failed.length > 0) {
        dispatch({
          type: "attach-notice",
          message: `Could not attach: ${failed.join(", ")}`,
        });
      }

      void sendTurn(finalText, attachments);
    },
    [
      paletteOpen,
      matches,
      paletteIndex,
      runSlashCommand,
      sendTurn,
      state.pendingAttachments,
      tryAttachPath,
      atPickerOpen,
      atMatches,
      acceptAtMatch,
    ]
  );

  const handleSpecialKey = useCallback(
    (key: { name: string; shift: boolean; ctrl: boolean; meta: boolean }) => {
      if (state.showHelp && key.name === "escape") {
        dispatch({ type: "close-overlays" });
        return true;
      }
      if (paletteOpen && matches.length > 0) {
        if (key.name === "up") {
          setPaletteIndex((i) =>
            i === 0 ? matches.length - 1 : i - 1
          );
          return true;
        }
        if (key.name === "down") {
          setPaletteIndex((i) =>
            i === matches.length - 1 ? 0 : i + 1
          );
          return true;
        }
        if (key.name === "tab") {
          const chosen = matches[paletteIndex];
          if (chosen) setInput(`/${chosen.name} `);
          return true;
        }
        if (key.name === "escape") {
          setInput("");
          return true;
        }
      }
      if (atPickerOpen && atMatches.length > 0) {
        if (key.name === "up") {
          setAtIndex((i) => (i === 0 ? atMatches.length - 1 : i - 1));
          return true;
        }
        if (key.name === "down") {
          setAtIndex((i) => (i === atMatches.length - 1 ? 0 : i + 1));
          return true;
        }
        if (key.name === "tab") {
          acceptAtMatch();
          return true;
        }
        if (key.name === "escape") {
          // Strip the trailing `@<query>` so the popup closes but the
          // user's prefix text survives.
          setInput((prev) => prev.replace(/(^|\s)@([^\s]*)$/, "$1"));
          return true;
        }
      }
      return false;
    },
    [
      paletteOpen,
      matches,
      paletteIndex,
      state.showHelp,
      atPickerOpen,
      atMatches,
      acceptAtMatch,
    ]
  );

  // Picker overlays disable the input.
  const inputDisabled =
    state.modelPickerOpen ||
    state.agentPickerOpen ||
    state.sessionPickerOpen ||
    state.skillsOverlayOpen ||
    state.mcpOverlayOpen ||
    state.tasksOverlayOpen ||
    state.status === "streaming";

  return (
    <Box flexDirection="column">
      <MessageList
        agentName={state.agentName}
        modelLabel={state.modelLabel}
        committed={state.committed}
        inflight={state.inflight}
      />

      {state.showHelp && <HelpOverlay />}

      {state.modelPickerOpen && (
        <ModelPicker
          currentProvider={agent.model.provider}
          currentModel={agent.model.model}
          configured={configuredProviders}
          onSelect={async ({ provider, model, label }) => {
            try {
              await manager.updateAgent(state.agentId, {
                model: { ...agent.model, provider, model },
              });
              dispatch({
                type: "set-model-label",
                modelLabel: label,
              });
            } catch (err) {
              dispatch({
                type: "stream-error",
                error: err instanceof Error ? err.message : String(err),
              });
              dispatch({ type: "close-overlays" });
            }
          }}
          onCancel={() => dispatch({ type: "close-overlays" })}
        />
      )}

      {state.agentPickerOpen && (
        <AgentPicker
          agents={manager.listAgents()}
          currentId={state.agentId}
          onSelect={(next) => {
            dispatch({
              type: "set-agent",
              agentId: next.id,
              agentName: next.name,
              modelLabel: `${next.model.provider}/${next.model.model}`,
            });
          }}
          onCancel={() => dispatch({ type: "close-overlays" })}
        />
      )}

      {state.sessionPickerOpen && (() => {
        const agents = manager.listAgents();
        const agentsById = new Map(agents.map((a) => [a.id, a]));
        // Hide sessions whose agent has been deleted — the next chat turn
        // would resolve to a missing AgentDefinition. listAllActive already
        // hides compression-parents.
        const rows: SessionRow[] = manager.sessionStore
          .listAllActive()
          .filter((s) => agentsById.has(s.agentId))
          .map((s) => ({
            id: s.id,
            title: s.title,
            agentId: s.agentId,
            updatedAt: s.updatedAt,
          }));
        return (
          <SessionPicker
            sessions={rows}
            agentsById={agentsById}
            currentSessionId={state.sessionId}
            onSelect={(picked) => {
              const owner = agentsById.get(picked.agentId);
              if (!owner) {
                dispatch({ type: "close-overlays" });
                return;
              }
              const dbHistory = sanitizeStoredHistory(
                manager.messageStore.getHistory(picked.id)
              );
              const committed = dbMessagesToTuiMessages(dbHistory);
              dispatch({
                type: "set-session",
                sessionId: picked.id,
                agentId: owner.id,
                agentName: owner.name,
                modelLabel: `${owner.model.provider}/${owner.model.model}`,
                committed,
              });
            }}
            onCancel={() => dispatch({ type: "close-overlays" })}
          />
        );
      })()}

      {state.skillsOverlayOpen && (
        <SkillsOverlay
          skills={manager.skillRegistry.getIndex()}
          onClose={() => dispatch({ type: "close-overlays" })}
        />
      )}

      {state.mcpOverlayOpen && (
        <MCPOverlay
          mcpClient={manager.getMcpClient(state.agentId)}
          dataDir={dataDir}
          onClose={() => dispatch({ type: "close-overlays" })}
        />
      )}

      {state.tasksOverlayOpen && (
        <TasksOverlay
          agentId={state.agentId}
          taskStore={manager.taskStore}
          onClose={() => dispatch({ type: "close-overlays" })}
        />
      )}

      {paletteOpen && (
        <CommandPalette query={input} selectedIndex={paletteIndex} />
      )}

      {atPickerOpen && (
        <FilePathPicker
          query={atQuery!}
          matches={atMatches}
          selectedIdx={atIndex}
          cwd={process.cwd()}
        />
      )}

      <PendingAttachmentsBar
        attachments={state.pendingAttachments}
        notice={state.attachNotice}
      />

      <StatusLine
        modelLabel={state.modelLabel}
        sessionId={state.sessionId}
        totalTokens={state.totalTokens}
        status={state.status}
      />

      <MultilineInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={inputDisabled}
        placeholder={
          state.status === "streaming"
            ? "(streaming…)"
            : "Send a message · drop a file · @path · / for commands"
        }
        onSpecialKey={handleSpecialKey}
        onPastePath={(rawPath) => tryAttachPath(rawPath)}
      />
    </Box>
  );
}

function HelpOverlay() {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color="yellow">Commands</Text>
      {COMMANDS.map((c) => (
        <Box key={c.name}>
          <Text color="cyan">/{c.name}</Text>
          {c.aliases?.map((a) => (
            <Text key={a} dimColor>{` (/${a})`}</Text>
          ))}
          <Text dimColor>{"  · " + c.description}</Text>
        </Box>
      ))}
      <Text dimColor> </Text>
      <Text dimColor>Esc to close</Text>
    </Box>
  );
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10);
}
