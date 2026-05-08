import { Box, Text, useApp, useInput } from "ink";
import { useReducer, useState, useMemo, useCallback, useRef } from "react";
import type { AgentManager } from "@openacme/server";
import type { AgentDefinition } from "@openacme/config";
import { detectProviderCredentials } from "@openacme/llm-provider";
import { reducer, initState } from "./state.js";
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
import { dbMessagesToTuiMessages } from "./restore.js";

interface Props {
  manager: AgentManager;
  agent: AgentDefinition;
  dataDir: string;
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
    async (text: string) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      dispatch({ type: "user-submit", text });

      try {
        for await (const chunk of manager.chat(
          state.agentId,
          state.sessionId,
          text,
          { signal: ctrl.signal }
        )) {
          dispatch({ type: "chunk", chunk });
        }
      } catch (err) {
        dispatch({
          type: "stream-error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
        sendingRef.current = false;
      }
    },
    [manager, state.agentId, state.sessionId]
  );

  // Esc-to-stop while streaming. Lives at the App level rather than inside
  // MultilineInput because that input is `disabled` mid-stream, which gates
  // its own useInput. Multiple Ink useInput hooks coexist fine.
  useInput((_input, key) => {
    if (key.escape && state.status === "streaming") {
      abortRef.current?.abort();
    }
  });

  // ── Slash command dispatch ─────────────────────────────────────────────
  const runSlashCommand = useCallback(
    async (raw: string) => {
      const cmd = findCommand(raw);
      if (!cmd) {
        // Unknown command; surface as a synthetic assistant error message.
        dispatch({ type: "user-submit", text: raw });
        dispatch({
          type: "stream-error",
          error: `Unknown command: ${raw.split(/\s+/)[0]}. Type /help.`,
        });
        // Finalize the empty inflight bubble.
        dispatch({
          type: "chunk",
          chunk: { type: "done", usage: undefined },
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
    !state.mcpOverlayOpen;
  const matches = paletteOpen ? filterCommands(input) : [];

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

      setInput("");
      setPaletteIndex(0);

      if (text.startsWith("/")) {
        void runSlashCommand(text);
        return;
      }
      void sendTurn(text);
    },
    [paletteOpen, matches, paletteIndex, runSlashCommand, sendTurn]
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
      return false;
    },
    [paletteOpen, matches, paletteIndex, state.showHelp]
  );

  // Picker overlays disable the input.
  const inputDisabled =
    state.modelPickerOpen ||
    state.agentPickerOpen ||
    state.sessionPickerOpen ||
    state.skillsOverlayOpen ||
    state.mcpOverlayOpen ||
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
              const dbHistory = manager.messageStore.getHistory(picked.id);
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

      {paletteOpen && (
        <CommandPalette query={input} selectedIndex={paletteIndex} />
      )}

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
            : "Send a message · / for commands · Ctrl+J for newline"
        }
        onSpecialKey={handleSpecialKey}
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
