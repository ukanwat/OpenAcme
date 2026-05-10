"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plug, Trash2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Textarea } from "@/app/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";

/** Wire-format MCP server config — matches MCPServerConfigSchema. */
export interface MCPServerConfigDto {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeout?: number;
  connectTimeout?: number;
  allowedTools?: string[];
  enabled?: boolean;
  transport?: "http" | "sse" | "stdio";
}

export interface MCPServerFormValue {
  name: string;
  config: MCPServerConfigDto;
}

interface Props {
  initial?: MCPServerFormValue;
  /** When set, the name field is locked — used in edit mode. */
  lockName?: boolean;
  /** Names already in use — disables save when chosen name collides. */
  reservedNames?: string[];
  onSubmit: (value: MCPServerFormValue) => Promise<void> | void;
  onCancel: () => void;
  onTest?: (value: MCPServerFormValue) => Promise<{ ok: boolean; error?: string; tools?: string[]; transport?: string }>;
}

type Kind = "stdio" | "url";

interface Pair {
  key: string;
  value: string;
}

function recordToPairs(rec?: Record<string, string>): Pair[] {
  if (!rec) return [];
  return Object.entries(rec).map(([key, value]) => ({ key, value }));
}

function pairsToRecord(pairs: Pair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    if (!key.trim()) continue;
    out[key.trim()] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function lineify(arr?: string[]): string {
  return (arr ?? []).join("\n");
}

function unlineify(text: string): string[] | undefined {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return lines.length > 0 ? lines : undefined;
}

export function MCPServerForm({
  initial,
  lockName,
  reservedNames,
  onSubmit,
  onCancel,
  onTest,
}: Props) {
  const initKind: Kind = initial?.config.command ? "stdio" : "url";

  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<Kind>(initKind);
  const [transport, setTransport] = useState<"" | "http" | "sse" | "stdio">(
    initial?.config.transport ?? ""
  );
  const [enabled, setEnabled] = useState<boolean>(initial?.config.enabled ?? true);

  // Stdio fields
  const [command, setCommand] = useState(initial?.config.command ?? "");
  const [argsText, setArgsText] = useState(lineify(initial?.config.args));
  const [envPairs, setEnvPairs] = useState<Pair[]>(
    recordToPairs(initial?.config.env)
  );

  // URL fields
  const [url, setUrl] = useState(initial?.config.url ?? "");
  const [headerPairs, setHeaderPairs] = useState<Pair[]>(
    recordToPairs(initial?.config.headers)
  );

  // Common
  const [allowedToolsText, setAllowedToolsText] = useState(
    lineify(initial?.config.allowedTools)
  );
  const [timeout, setTimeout] = useState<string>(
    initial?.config.timeout?.toString() ?? ""
  );
  const [connectTimeout, setConnectTimeout] = useState<string>(
    initial?.config.connectTimeout?.toString() ?? ""
  );

  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const nameError = useMemo(() => {
    if (!name.trim()) return "Name is required";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name.trim())) {
      return "Name must start with a letter/digit; only letters, digits, _, ., - allowed";
    }
    if (
      !lockName &&
      reservedNames &&
      reservedNames.includes(name.trim())
    ) {
      return "A server with this name already exists";
    }
    return null;
  }, [name, lockName, reservedNames]);

  const fieldError = useMemo(() => {
    if (kind === "stdio" && !command.trim()) return "Command is required for stdio transport";
    if (kind === "url" && !url.trim()) return "URL is required for HTTP/SSE transport";
    if (kind === "url") {
      try {
        new URL(url.trim());
      } catch {
        return "URL is not valid";
      }
    }
    return null;
  }, [kind, command, url]);

  const buildValue = (): MCPServerFormValue => {
    const cfg: MCPServerConfigDto = {
      enabled,
      transport: transport || undefined,
      timeout: timeout ? Number(timeout) : undefined,
      connectTimeout: connectTimeout ? Number(connectTimeout) : undefined,
      allowedTools: unlineify(allowedToolsText),
    };
    if (kind === "stdio") {
      cfg.command = command.trim();
      cfg.args = unlineify(argsText);
      cfg.env = pairsToRecord(envPairs);
    } else {
      cfg.url = url.trim();
      cfg.headers = pairsToRecord(headerPairs);
    }
    return { name: name.trim(), config: cfg };
  };

  useEffect(() => {
    setTestResult(null);
  }, [name, kind, transport, command, argsText, url, envPairs, headerPairs]);

  const canSubmit = !nameError && !fieldError && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(buildValue());
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async () => {
    if (!onTest || fieldError) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await onTest(buildValue());
      setTestResult({
        ok: r.ok,
        message: r.ok
          ? `Connected via ${r.transport ?? "?"} — ${r.tools?.length ?? 0} tools`
          : r.error ?? "Connection failed",
      });
    } catch (e) {
      setTestResult({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="mcp-name">Name</Label>
        <Input
          id="mcp-name"
          value={name}
          disabled={lockName}
          onChange={(e) => setName(e.target.value)}
          placeholder="filesystem"
        />
        {nameError && (
          <p className="text-xs text-destructive">{nameError}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label>Server type</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">Local subprocess (stdio)</SelectItem>
              <SelectItem value="url">Remote (HTTP / SSE)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Transport</Label>
          <Select
            value={transport === "" ? "auto" : transport}
            onValueChange={(v) => setTransport(v === "auto" ? "" : (v as "http" | "sse" | "stdio"))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                Auto-detect {kind === "url" ? "(HTTP, fall back to SSE)" : "(stdio)"}
              </SelectItem>
              {kind === "url" && <SelectItem value="http">Streamable HTTP</SelectItem>}
              {kind === "url" && <SelectItem value="sse">SSE (legacy)</SelectItem>}
              {kind === "stdio" && <SelectItem value="stdio">stdio</SelectItem>}
            </SelectContent>
          </Select>
        </div>
      </div>

      {kind === "stdio" ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-command">Command</Label>
            <Input
              id="mcp-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-args">Arguments (one per line)</Label>
            <Textarea
              id="mcp-args"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={`-y\n@modelcontextprotocol/server-filesystem\n/path/to/allowed/dir`}
              className="font-mono text-xs"
              rows={4}
            />
          </div>
          <PairsEditor
            label="Environment variables"
            pairs={envPairs}
            onChange={setEnvPairs}
            keyPlaceholder="MY_VAR"
            valuePlaceholder="value"
          />
        </>
      ) : (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/mcp"
            />
          </div>
          <PairsEditor
            label="Headers"
            pairs={headerPairs}
            onChange={setHeaderPairs}
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer …"
          />
        </>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="mcp-allowed">Allowed tools (one per line, blank = all)</Label>
        <Textarea
          id="mcp-allowed"
          value={allowedToolsText}
          onChange={(e) => setAllowedToolsText(e.target.value)}
          placeholder="read_file&#10;list_files"
          className="font-mono text-xs"
          rows={3}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="mcp-connect-timeout">Connect timeout (s)</Label>
          <Input
            id="mcp-connect-timeout"
            inputMode="numeric"
            value={connectTimeout}
            onChange={(e) => setConnectTimeout(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="60"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="mcp-tool-timeout">Tool call timeout (s)</Label>
          <Input
            id="mcp-tool-timeout"
            inputMode="numeric"
            value={timeout}
            onChange={(e) => setTimeout(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="120"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="size-4"
        />
        Enabled (uncheck to keep config but skip connecting)
      </label>

      {fieldError && (
        <p className="text-xs text-destructive">{fieldError}</p>
      )}

      {testResult && (
        <p
          className={`font-mono text-[12px] ${testResult.ok ? "text-plot-red" : "text-destructive"}`}
        >
          {testResult.message}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        {onTest && (
          <Button
            type="button"
            variant="ghost"
            disabled={!!fieldError || testing}
            onClick={handleTest}
          >
            {testing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plug className="size-4" />
            )}
            Test
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {initial ? "Save" : "Add server"}
        </Button>
      </div>
    </div>
  );
}

function PairsEditor({
  label,
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  pairs: Pair[];
  onChange: (next: Pair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const update = (i: number, patch: Partial<Pair>) => {
    onChange(pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  };
  const remove = (i: number) => onChange(pairs.filter((_, idx) => idx !== i));
  const add = () => onChange([...pairs, { key: "", value: "" }]);

  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="grid gap-2">
        {pairs.map((p, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={p.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder={keyPlaceholder}
              className="font-mono text-xs"
            />
            <Input
              value={p.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={valuePlaceholder}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              aria-label="Remove"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={add}>
          + Add row
        </Button>
      </div>
    </div>
  );
}
