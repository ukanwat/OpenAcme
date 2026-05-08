import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { MCPClient, ServerStatus } from "@openacme/mcp-client";

interface Props {
  mcpClient?: MCPClient;
  dataDir: string;
  onClose: () => void;
}

/**
 * Read-mostly overlay over the agent's MCP servers. Editing the catalog
 * happens in `~/.openacme/mcp.json` directly (or via the web UI) — keeping
 * the TUI surface minimal. The overlay supports per-server lifecycle:
 *
 *   ↑/↓    move selection
 *   r      reconnect selected server
 *   d      disconnect selected server (config retained)
 *   p      print the catalog file path so you can $EDITOR it
 *   Esc    close
 */
export function MCPOverlay({ mcpClient, dataDir, onClose }: Props) {
  const [servers, setServers] = useState<ServerStatus[]>(
    mcpClient?.getStatus() ?? []
  );
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Light polling — connection states transition asynchronously after
  // a connect/disconnect call. 1s is fast enough that the UI feels live.
  useEffect(() => {
    const id = setInterval(() => {
      if (!mcpClient) return;
      setServers(mcpClient.getStatus());
    }, 1000);
    return () => clearInterval(id);
  }, [mcpClient]);

  useInput((input, key) => {
    if (busy) return;
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.min(servers.length - 1, i + 1));
      return;
    }
    if (input === "p") {
      setMessage(`Edit: ${dataDir}/mcp.json`);
      return;
    }
    const target = servers[selected];
    if (!target || !mcpClient) return;
    if (input === "r") {
      void runAction(`Reconnecting ${target.name}…`, async () => {
        await mcpClient.reconnect(target.name);
      });
      return;
    }
    if (input === "d") {
      void runAction(`Disconnecting ${target.name}…`, async () => {
        await mcpClient.disconnectServer(target.name);
      });
      return;
    }
  });

  const runAction = async (
    label: string,
    fn: () => Promise<void>
  ): Promise<void> => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
      setServers(mcpClient?.getStatus() ?? []);
    } catch (e) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const stateColor = (state: ServerStatus["state"]) => {
    switch (state) {
      case "connected":
        return "green";
      case "awaiting_oauth":
        return "yellow";
      case "failed":
        return "red";
      case "connecting":
        return "blue";
      default:
        return "gray";
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color="magenta">
        MCP servers{servers.length > 0 ? ` (${servers.length})` : ""}
      </Text>
      {servers.length === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>No MCP servers configured for this agent.</Text>
          <Text dimColor>{`Edit ${dataDir}/mcp.json to add one.`}</Text>
          <Text dimColor>
            Same JSON shape Claude Desktop / Cursor / Cline use.
          </Text>
        </Box>
      ) : (
        servers.map((s, i) => (
          <Box key={s.name} flexDirection="column" marginTop={1}>
            <Box>
              <Text color={i === selected ? "magenta" : undefined}>
                {i === selected ? "❯ " : "  "}
              </Text>
              <Text color="cyan">{s.name}</Text>
              <Text>{"  "}</Text>
              <Text color={stateColor(s.state)}>{s.state}</Text>
              {s.transport && (
                <Text dimColor>{`  via ${s.transport}`}</Text>
              )}
              {s.toolCount > 0 && (
                <Text dimColor>{`  ${s.toolCount} tools`}</Text>
              )}
            </Box>
            {s.lastError && (
              <Text color="red">{`    ${s.lastError}`}</Text>
            )}
          </Box>
        ))
      )}
      {busy && (
        <Box marginTop={1}>
          <Text color="yellow">{busy}</Text>
        </Box>
      )}
      {message && (
        <Box marginTop={1}>
          <Text dimColor>{message}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ select · r reconnect · d disconnect · p print file path · Esc
          close
        </Text>
      </Box>
    </Box>
  );
}
