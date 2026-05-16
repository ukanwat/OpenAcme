import { Box, Text, useStdout } from "ink";
import type { ReactNode } from "react";
import type { UIMessage } from "@openacme/agent-core";
import {
  KNOWN_TOOLS,
  countResults,
  editToFile,
  firstNonEmptyLine,
  formatOutput,
  isObj,
  num,
  parseJsonish,
  parseV4APatch,
  pickResults,
  pickTaskId,
  safeStringify,
  shortPath,
  str,
  trim,
  type DiffFile,
  type DiffHunk,
} from "../tool-render.js";
import { renderMarkdown } from "../markdown.js";

type ToolUIPart = Extract<UIMessage["parts"][number], { type: `tool-${string}` }>;

interface PartShape {
  type: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

const INTERRUPT_MARKER = "[interrupted]";

type Status = "running" | "done" | "error" | "interrupted";

function computeStatus(p: PartShape, streaming: boolean | undefined): Status {
  const interrupted =
    p.state === "output-error" && p.errorText === INTERRUPT_MARKER;
  if (interrupted) return "interrupted";
  if (p.state === "output-error") return "error";
  if (p.state === "input-streaming" || p.state === "input-available") {
    return streaming ? "running" : "interrupted";
  }
  return "done";
}

function StatusGlyph({ status }: { status: Status }) {
  if (status === "running") return <Text color="yellow">·</Text>;
  if (status === "interrupted") return <Text color="yellow">⊘</Text>;
  if (status === "error") return <Text color="red">✗</Text>;
  return <Text color="green">✓</Text>;
}

export function ToolBlock({
  part,
  streaming,
}: {
  part: ToolUIPart;
  streaming?: boolean;
}) {
  const p = part as unknown as PartShape;
  const toolName = p.type.slice("tool-".length);
  const known = KNOWN_TOOLS.has(toolName);
  const status = computeStatus(p, streaming);

  const summary = known ? renderSummary(toolName, p.input, p.output) : null;
  const body =
    known && status !== "interrupted"
      ? renderBody({
          name: toolName,
          input: p.input,
          output: p.output,
          errorText: p.errorText,
          status,
        })
      : null;

  // Unknown tools: name + a tight one-line args/result hint. No body —
  // terminals can't do click-to-expand.
  const fallbackHint = !known ? unknownHint(p) : null;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={0}>
      <Box>
        <StatusGlyph status={status} />
        <Text> </Text>
        <Text color="cyan" bold>{toolName}</Text>
        {summary && (
          <>
            <Text dimColor>  ·  </Text>
            {summary}
          </>
        )}
        {fallbackHint && (
          <>
            <Text dimColor>  ·  </Text>
            <Text dimColor>{fallbackHint}</Text>
          </>
        )}
        {status === "interrupted" && (
          <Text color="yellow" dimColor>  ·  interrupted</Text>
        )}
      </Box>
      {body && (
        <Box
          flexDirection="column"
          marginLeft={2}
          paddingLeft={1}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor="gray"
          borderDimColor
        >
          {body}
        </Box>
      )}
    </Box>
  );
}

// ── Summary line ────────────────────────────────────────────────────────────

function renderSummary(name: string, input: unknown, output: unknown): ReactNode {
  if (!isObj(input)) return null;

  switch (name) {
    case "read_file":
    case "write_file": {
      const path = str(input["path"]);
      const bytes =
        name === "write_file" ? num(parseJsonish(output)?.["bytesWritten"]) : null;
      return (
        <Box>
          {path && <PathChip path={path} />}
          {bytes !== null && (
            <>
              <Text dimColor>  ·  </Text>
              <Text dimColor>{bytes} B</Text>
            </>
          )}
        </Box>
      );
    }
    case "edit": {
      const path = str(input["path"]);
      const oldS = str(input["oldString"]) ?? "";
      const newS = str(input["newString"]) ?? "";
      const f = editToFile(path ?? "", oldS, newS);
      return (
        <Box>
          {path && <PathChip path={path} />}
          {(f.added > 0 || f.removed > 0) && (
            <>
              <Text dimColor>  ·  </Text>
              <DiffStat added={f.added} removed={f.removed} />
            </>
          )}
        </Box>
      );
    }
    case "apply_patch": {
      const text = str(input["patchText"]) ?? "";
      const files = parseV4APatch(text);
      const totalAdded = files.reduce((a, f) => a + f.added, 0);
      const totalRemoved = files.reduce((a, f) => a + f.removed, 0);
      const path = files.length === 1 ? files[0]?.path : undefined;
      return (
        <Box>
          {path ? (
            <PathChip path={path} />
          ) : (
            <Text dimColor>{files.length} files</Text>
          )}
          {(totalAdded > 0 || totalRemoved > 0) && (
            <>
              <Text dimColor>  ·  </Text>
              <DiffStat added={totalAdded} removed={totalRemoved} />
            </>
          )}
        </Box>
      );
    }
    case "list_files": {
      const path = str(input["path"]);
      return path ? <PathChip path={path} /> : <Text dimColor>cwd</Text>;
    }
    case "search_files": {
      const pat = str(input["pattern"]) ?? str(input["query"]);
      const where = str(input["path"]);
      return (
        <Box>
          {pat && <Text color="magenta">{trim(pat, 60)}</Text>}
          {where && (
            <>
              <Text dimColor>  in  </Text>
              <PathChip path={where} />
            </>
          )}
        </Box>
      );
    }
    case "shell": {
      const cmd = str(input["command"]);
      return cmd ? <Text>{firstNonEmptyLine(cmd)}</Text> : null;
    }
    case "execute_code": {
      const code = str(input["code"]) ?? "";
      const first = firstNonEmptyLine(code);
      return first ? <Text>{first}</Text> : null;
    }
    case "web_search":
    case "session_search": {
      const q = str(input["query"]);
      const out = parseJsonish(output);
      const n = countResults(out);
      return (
        <Box>
          {q && <Text color="magenta">{trim(q, 60)}</Text>}
          {n !== null && (
            <>
              <Text dimColor>  ·  </Text>
              <Text dimColor>{n} {n === 1 ? "result" : "results"}</Text>
            </>
          )}
        </Box>
      );
    }
    case "web_extract": {
      const u = str(input["url"]);
      return u ? <Text>{trim(u, 80)}</Text> : null;
    }
    case "skill_view": {
      const n = str(input["name"]);
      return n ? <Text>{n}</Text> : null;
    }
    case "memory": {
      const a = str(input["action"]);
      const c = str(input["content"]);
      return (
        <Box>
          {a && <Text>{a}</Text>}
          {c && (
            <>
              <Text dimColor>  ·  </Text>
              <Text dimColor>{trim(c, 60)}</Text>
            </>
          )}
        </Box>
      );
    }
    case "task_create": {
      const t = str(input["title"]);
      const out = parseJsonish(output);
      const createdId = str(pickTaskId(out));
      return (
        <Box>
          {createdId && <Text color="magenta">{createdId.slice(0, 8)}</Text>}
          {t && (
            <>
              {createdId && <Text dimColor>  ·  </Text>}
              <Text>{trim(t, 60)}</Text>
            </>
          )}
        </Box>
      );
    }
    case "task_view":
    case "task_update": {
      const id = str(input["task_id"]) ?? str(input["id"]);
      const status = str(input["status"]);
      return (
        <Box>
          {id && <Text color="magenta">{id.slice(0, 8)}</Text>}
          {status && (
            <>
              {id && <Text dimColor>  ·  </Text>}
              <Text dimColor>{status}</Text>
            </>
          )}
        </Box>
      );
    }
    case "task_comment": {
      const id = str(input["task_id"]) ?? str(input["id"]);
      const kind = str(input["kind"]);
      return (
        <Box>
          {id && <Text color="magenta">{id.slice(0, 8)}</Text>}
          {kind && (
            <>
              {id && <Text dimColor>  ·  </Text>}
              <Text dimColor>{kind}</Text>
            </>
          )}
        </Box>
      );
    }
    case "task_comments": {
      const id = str(input["task_id"]) ?? str(input["id"]);
      const out = parseJsonish(output);
      const n = countResults(out) ?? num(out?.["count"]);
      return (
        <Box>
          {id && <Text color="magenta">{id.slice(0, 8)}</Text>}
          {n !== null && (
            <>
              {id && <Text dimColor>  ·  </Text>}
              <Text dimColor>{n} {n === 1 ? "comment" : "comments"}</Text>
            </>
          )}
        </Box>
      );
    }
    case "task_list": {
      const filt = [str(input["assignee"]), str(input["status"])]
        .filter(Boolean)
        .join(" · ");
      const out = parseJsonish(output);
      const n = countResults(out);
      return (
        <Box>
          <Text dimColor>{filt || "all"}</Text>
          {n !== null && (
            <>
              <Text dimColor>  ·  </Text>
              <Text dimColor>{n} {n === 1 ? "task" : "tasks"}</Text>
            </>
          )}
        </Box>
      );
    }
    case "process": {
      const a = str(input["action"]);
      const id = str(input["id"]);
      const cmd = str(input["command"]);
      return (
        <Box>
          {a && <Text>{a}</Text>}
          {id && (
            <>
              {a && <Text dimColor>  ·  </Text>}
              <Text color="magenta">{id}</Text>
            </>
          )}
          {cmd && (
            <>
              <Text dimColor>  ·  </Text>
              <Text>{firstNonEmptyLine(cmd)}</Text>
            </>
          )}
        </Box>
      );
    }
    case "ping_user": {
      const msg = str(input["message"]);
      return msg ? <Text>{trim(msg, 80)}</Text> : null;
    }
    case "sleep": {
      const dur = str(input["duration"]);
      const out = parseJsonish(output);
      const next = str(out?.["next_check_at"]);
      return (
        <Box>
          {dur && <Text>{dur}</Text>}
          {next && (
            <>
              {dur && <Text dimColor>  ·  </Text>}
              <Text dimColor>until {new Date(next).toLocaleString()}</Text>
            </>
          )}
        </Box>
      );
    }
    default:
      return null;
  }
}

function PathChip({ path }: { path: string }) {
  return <Text color="cyan">{shortPath(path)}</Text>;
}

// ── Body (under header for known tools) ─────────────────────────────────────

function renderBody({
  name,
  input,
  output,
  errorText,
  status,
}: {
  name: string;
  input: unknown;
  output: unknown;
  errorText?: string;
  status: Status;
}): ReactNode {
  if (errorText && errorText !== INTERRUPT_MARKER) {
    return (
      <Text color="red">{trim(errorText, 2000)}</Text>
    );
  }
  if (status === "running") return null;
  if (!isObj(input)) return null;

  switch (name) {
    case "edit": {
      const path = str(input["path"]) ?? "(unknown)";
      const oldS = str(input["oldString"]) ?? "";
      const newS = str(input["newString"]) ?? "";
      if (oldS === "" && newS === "") return null;
      return <FileDiffView files={[editToFile(path, oldS, newS)]} />;
    }
    case "apply_patch": {
      const text = str(input["patchText"]) ?? "";
      if (!text) return null;
      const files = parseV4APatch(text);
      if (files.length === 0) return null;
      return <FileDiffView files={files} />;
    }
    case "shell":
    case "execute_code":
      return <ShellOutputView output={output} />;
    case "web_search":
    case "session_search": {
      const out = parseJsonish(output);
      const results = pickResults(out);
      if (!results || results.length === 0) return null;
      return <SearchResultsView results={results.slice(0, 5)} />;
    }
    case "process": {
      const out = parseJsonish(output);
      const log = out && (str(out["output"]) ?? str(out["log"]));
      if (!log) return null;
      return <Text dimColor>{trim(log, 2000)}</Text>;
    }
    case "ping_user": {
      const msg = str(input["message"]);
      if (!msg) return null;
      return <Text>{renderMarkdown(msg)}</Text>;
    }
    case "read_file":
    case "write_file":
    case "list_files":
    case "search_files":
    case "web_extract":
    case "skill_view":
    case "memory":
    case "task_create":
    case "task_view":
    case "task_update":
    case "task_list":
    case "task_comment":
    case "task_comments":
    case "sleep":
      return null;
    default:
      return null;
  }
}

function ShellOutputView({ output }: { output: unknown }) {
  const out = parseJsonish(output);
  const stdout = out && (str(out["output"]) ?? str(out["stdout"]));
  const stderr = out && str(out["stderr"]);
  const value = out && str(out["value"]);
  const errMsg = out && str(out["error"]);
  if (!stdout && !stderr && !value && !errMsg) {
    // Fall back to a raw preview if the output isn't the expected shape.
    if (output === undefined || output === null) return null;
    return <Text dimColor>{trim(formatOutput(output), 2000)}</Text>;
  }
  return (
    <Box flexDirection="column">
      {stdout && <Text dimColor>{trim(stdout, 2000)}</Text>}
      {value && <Text>{trim(value, 1000)}</Text>}
      {stderr && <Text dimColor>{trim(stderr, 1000)}</Text>}
      {errMsg && <Text color="red">{trim(errMsg, 1000)}</Text>}
    </Box>
  );
}

function SearchResultsView({
  results,
}: {
  results: { title?: string; url?: string; snippet?: string }[];
}) {
  return (
    <Box flexDirection="column">
      {results.map((r, i) => (
        <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          {r.title && <Text>{trim(r.title, 100)}</Text>}
          {r.url && <Text dimColor>{trim(r.url, 100)}</Text>}
          {r.snippet && <Text dimColor>{trim(r.snippet, 200)}</Text>}
        </Box>
      ))}
    </Box>
  );
}

// ── Diff view ───────────────────────────────────────────────────────────────

function FileDiffView({ files }: { files: DiffFile[] }) {
  if (files.length === 0) return null;
  return (
    <Box flexDirection="column">
      {files.map((f, i) => (
        <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          <FileDiffBlock file={f} />
        </Box>
      ))}
    </Box>
  );
}

function FileDiffBlock({ file }: { file: DiffFile }) {
  const kindLabel: Record<DiffFile["kind"], string> = {
    add: "added",
    update: "updated",
    delete: "deleted",
    move: "moved",
    edit: "edited",
  };
  const headerPath =
    file.kind === "move" && file.newPath
      ? `${file.path} → ${file.newPath}`
      : shortPath(file.path);
  // Pre-walk to size the single line-number gutter. Show new line numbers
  // for context + added rows, old line numbers for removed rows.
  let maxNo = 0,
    oldNo = 1,
    newNo = 1;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      const n = l.type === "-" ? oldNo : newNo;
      if (n > maxNo) maxNo = n;
      if (l.type === " ") {
        oldNo++;
        newNo++;
      } else if (l.type === "-") {
        oldNo++;
      } else {
        newNo++;
      }
    }
  }
  const gutter = Math.max(2, String(maxNo).length);
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{kindLabel[file.kind]} </Text>
        <Text color="cyan">{headerPath}</Text>
        {(file.added > 0 || file.removed > 0) && <Text>  </Text>}
        {file.added > 0 && <Text color="green">+{file.added}</Text>}
        {file.added > 0 && file.removed > 0 && <Text> </Text>}
        {file.removed > 0 && <Text color="red">−{file.removed}</Text>}
      </Box>
      <HunksView hunks={file.hunks} gutter={gutter} />
    </Box>
  );
}

function HunksView({ hunks, gutter }: { hunks: DiffHunk[]; gutter: number }) {
  const { stdout } = useStdout();
  // Width budget inside the body's left rail. Outer indent is
  // marginLeft (2) + border (1) + paddingLeft (1) = 4 cols; pull one more
  // off so the padded background never bumps the terminal edge and wraps.
  const cols = stdout?.columns ?? 80;
  const rowWidth = Math.max(20, cols - 6);

  let oldNo = 1;
  let newNo = 1;
  return (
    <Box flexDirection="column">
      {hunks.map((h, hi) => (
        <Box key={hi} flexDirection="column" marginTop={hi === 0 ? 0 : 1}>
          {h.lines.map((l, i) => {
            let n: number;
            if (l.type === " ") {
              n = newNo;
              oldNo++;
              newNo++;
            } else if (l.type === "-") {
              n = oldNo++;
            } else {
              n = newNo++;
            }
            const sigil = l.type === " " ? " " : l.type;
            const raw = `${pad(n, gutter)} ${sigil} ${l.text}`;
            const padded =
              raw.length >= rowWidth ? raw : raw + " ".repeat(rowWidth - raw.length);

            // Subtle row background — bright enough to read against, muted so
            // the eye lands on the sigil/text first. Hex keeps it consistent
            // across dark/light terminal themes.
            if (l.type === "+") {
              return (
                <Text
                  key={i}
                  wrap="truncate"
                  backgroundColor="#1f3a1f"
                  color="green"
                >
                  {padded}
                </Text>
              );
            }
            if (l.type === "-") {
              return (
                <Text
                  key={i}
                  wrap="truncate"
                  backgroundColor="#3a1f1f"
                  color="red"
                >
                  {padded}
                </Text>
              );
            }
            return (
              <Text key={i} wrap="truncate" dimColor>
                {padded}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, " ");
}

// ── Small bits ──────────────────────────────────────────────────────────────

function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <Box>
      {added > 0 && <Text color="green">+{added}</Text>}
      {added > 0 && removed > 0 && <Text> </Text>}
      {removed > 0 && <Text color="red">−{removed}</Text>}
    </Box>
  );
}

function unknownHint(p: PartShape): string | null {
  // One-line hint for unknown/MCP tools — just enough to identify the call.
  if (p.input !== undefined) {
    try {
      const j = safeStringify(p.input).replace(/\s+/g, " ");
      if (j && j !== "{}") return j.length > 80 ? j.slice(0, 77) + "…" : j;
    } catch {
      /* ignore */
    }
  }
  return null;
}
