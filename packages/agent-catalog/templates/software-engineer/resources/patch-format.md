# Patch format (V4A) for `apply_patch`

The `apply_patch` tool takes a patch in OpenAI's V4A format. It is NOT unified diff — `jsdiff` and `patch -p1` cannot parse it. The format is human-readable and context-anchored rather than line-number-anchored.

## Envelope

Every patch is wrapped in begin/end markers:

```
*** Begin Patch
... operations ...
*** End Patch
```

Inside the envelope, each operation starts with one of three headers.

## Operations

### Add a new file

```
*** Add File: path/to/new.ts
+export function hello() {
+  return "world";
+}
```

Every line of the new file is prefixed with `+`. No context lines.

### Delete a file

```
*** Delete File: path/to/old.ts
```

No body.

### Update an existing file

```
*** Update File: src/utils/parse.ts
@@ function parseConfig
 export function parseConfig(input: string) {
-  return JSON.parse(input);
+  const cleaned = input.trim();
+  return JSON.parse(cleaned);
 }
```

- `@@ <context>` is an anchor (e.g. function name, class name) so the parser can locate the chunk in a long file. Optional but strongly recommended for files over ~100 lines.
- Lines starting with a single space are context (unchanged, must match the source exactly).
- Lines starting with `-` are removed.
- Lines starting with `+` are added.

### Move (rename) a file

```
*** Update File: old/path.ts
*** Move to: new/path.ts
@@ function example
 export function example() {
-  return 1;
+  return 2;
 }
```

`*** Move to:` immediately follows `*** Update File:`. Body is a normal update chunk; the file is renamed after the chunks apply.

### End-of-file edits

When editing the last lines of a file, terminate the chunk with `*** End of File`:

```
*** Update File: src/index.ts
@@ end
 export { foo };
+export { bar };
*** End of File
```

## Multiple files in one patch

Stack operations between the begin/end markers:

```
*** Begin Patch
*** Update File: src/a.ts
@@ function a
 export function a() {
-  return 1;
+  return 2;
 }
*** Update File: src/b.ts
@@ function b
 export function b() {
-  return 3;
+  return 4;
 }
*** Add File: src/c.ts
+export const c = 5;
*** End Patch
```

The whole patch applies atomically — if any single file fails (context mismatch, file not found), nothing lands.

## Common failure modes

- **Context mismatch.** The ` ` (space-prefixed) lines must match the source character-for-character, including whitespace. Re-read the file before generating the patch; don't work from memory.
- **Missing `@@` anchor in a long file.** Add one — a function name, a class name, a unique comment.
- **Forgot the envelope.** `*** Begin Patch` / `*** End Patch` are required.
- **Wrapping the patch in a shell heredoc.** Don't. Pass the patch directly. (The parser will strip a `<<EOF`-style wrapper if you do, but don't rely on it — it's a safety net for typos, not the intended path.)
- **Leading BOM** in the source file. The tool handles BOMs internally; just match the source content, no special handling needed.

## When to reach for `edit` instead

For a single-file, single-hunk change, `edit` is simpler and faster — it takes `oldString` / `newString` and doesn't need anchors. Use `apply_patch` when:

- The change spans multiple files.
- The change has multiple non-overlapping hunks in one file.
- You want one atomic operation that either all-applies or all-rolls-back.
