import { Box, Text, useApp } from "ink";
import { useReducer, useState, useMemo, useCallback, useRef } from "react";
import type { AgentManager } from "@openacme/server";
import type { AgentDefinition } from "@openacme/config";
import { reducer, initState } from "./state.js";
import { COMMANDS, findCommand, filterCommands, type CommandCtx } from "./commands.js";
import { MessageList } from "./components/MessageList.js";
import { StatusLine } from "./components/StatusLine.js";
import { MultilineInput } from "./components/MultilineInput.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { AgentPicker } from "./components/AgentPicker.js";

interface Props {
  manager: AgentManager;
  agent: AgentDefinition;
}

export function App({ manager, agent }: Props) {
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

  const exit = useCallback(() => {
    inkApp.exit();
  }, [inkApp]);

  const ctx: CommandCtx = useMemo(
    () => ({ dispatch, manager, agentId: state.agentId, exit }),
    [manager, state.agentId, exit]
  );

  // ── Send a turn ────────────────────────────────────────────────────────
  const sendTurn = useCallback(
    async (text: string) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      dispatch({ type: "user-submit", text });

      try {
        for await (const chunk of manager.chat(
          state.agentId,
          state.sessionId,
          text
        )) {
          dispatch({ type: "chunk", chunk });
        }
      } catch (err) {
        dispatch({
          type: "stream-error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        sendingRef.current = false;
      }
    },
    [manager, state.agentId, state.sessionId]
  );

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

  // ── Submit ─────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setInput("");
      setPaletteIndex(0);

      if (text.startsWith("/")) {
        void runSlashCommand(text);
        return;
      }
      void sendTurn(text);
    },
    [runSlashCommand, sendTurn]
  );

  // ── Palette interception ───────────────────────────────────────────────
  const paletteOpen = input.startsWith("/") && !state.modelPickerOpen && !state.agentPickerOpen;
  const matches = paletteOpen ? filterCommands(input) : [];

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
    state.modelPickerOpen || state.agentPickerOpen || state.status === "streaming";

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
          onSelect={async ({ provider, model, label }) => {
            try {
              manager.updateAgent(state.agentId, {
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
