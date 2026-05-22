import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { registry } from "../registry.js";

const paramsSchema = z.object({
  path: z
    .string()
    .describe(
      "Absolute path to the local file to upload (e.g. /Users/.../chart.png)."
    ),
});

// 200MB is catbox's documented per-file ceiling. Most use cases stay well
// under, but we reject above this so a runaway file doesn't burn time on a
// guaranteed-failed upload.
const MAX_BYTES = 200 * 1024 * 1024;

registry.register({
  name: "web_upload",
  toolset: "web",
  description:
    "Upload a local file to a public host (catbox.moe) and return a permanent public URL. " +
    "Use this when you need a file on local disk to be reachable by a third-party service that " +
    "only accepts URLs (e.g. social-media APIs that take image_urls but not binary uploads). " +
    "Anonymous, no API key required. Files are permanent unless reported. " +
    "Returns JSON `{url, size, basename}` on success or `{error}` on failure. " +
    "Max file size 200MB.",
  parameters: paramsSchema,
  async handler(args) {
    const { path: filePath } = args as z.infer<typeof paramsSchema>;
    if (!path.isAbsolute(filePath)) {
      return JSON.stringify({
        error: `path must be absolute, got: ${filePath}`,
      });
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return JSON.stringify({ error: `file not found: ${filePath}` });
    }
    if (!stat.isFile()) {
      return JSON.stringify({ error: `not a regular file: ${filePath}` });
    }
    if (stat.size === 0) {
      return JSON.stringify({ error: `file is empty: ${filePath}` });
    }
    if (stat.size > MAX_BYTES) {
      return JSON.stringify({
        error: `file too large: ${stat.size} bytes (max ${MAX_BYTES})`,
      });
    }

    const basename = path.basename(filePath);
    const bytes = await fs.promises.readFile(filePath);

    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append(
      "fileToUpload",
      new Blob([new Uint8Array(bytes)]),
      basename
    );

    let resp: Response;
    try {
      resp = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        body: form,
      });
    } catch (e) {
      return JSON.stringify({
        error: `network failure uploading to catbox.moe: ${(e as Error).message}`,
      });
    }

    const body = (await resp.text()).trim();
    if (!resp.ok) {
      return JSON.stringify({
        error: `catbox.moe rejected upload: HTTP ${resp.status} — ${body.slice(0, 300)}`,
      });
    }
    if (!body.startsWith("http")) {
      return JSON.stringify({
        error: `catbox.moe returned non-URL response: ${body.slice(0, 300)}`,
      });
    }

    return JSON.stringify({
      url: body,
      size: stat.size,
      basename,
    });
  },
});
