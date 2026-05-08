import * as fs from "node:fs";
import * as path from "node:path";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Per-server credential persistence for MCP OAuth flows.
 *
 * Three things move through here, all per-server:
 *   - tokens (access/refresh) returned after auth code exchange
 *   - client info from RFC 7591 Dynamic Client Registration
 *   - PKCE code verifier (in-flight, between authorize and finishAuth)
 *
 * The PKCE verifier must round-trip through the same MCPTokenStore the
 * `OAuthClientProvider` uses — the SDK saves it before redirect and reads
 * it on `finishAuth`, possibly across process restarts. An in-memory store
 * is fine for tests; production uses `FileMCPTokenStore`.
 */
export interface MCPTokenStore {
  getTokens(name: string): Promise<OAuthTokens | undefined>;
  saveTokens(name: string, tokens: OAuthTokens): Promise<void>;
  deleteTokens(name: string): Promise<void>;

  getClientInfo(name: string): Promise<OAuthClientInformationFull | undefined>;
  saveClientInfo(
    name: string,
    info: OAuthClientInformationFull
  ): Promise<void>;

  getCodeVerifier(name: string): Promise<string | undefined>;
  saveCodeVerifier(name: string, verifier: string): Promise<void>;
}

interface FileShape {
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformationFull;
  codeVerifier?: string;
}

/**
 * Stores per-server credentials at `<dir>/<server>.json`, mode 0600.
 * Atomic writes via tempfile + rename (mirrors @openacme/auth/store.ts).
 *
 * Tokens never appear in `mcp.json` or `config.yaml` — those are
 * round-tripped through user-edited paths and would shuffle credentials
 * around on every save.
 */
export class FileMCPTokenStore implements MCPTokenStore {
  constructor(private readonly dir: string) {}

  async getTokens(name: string): Promise<OAuthTokens | undefined> {
    return (await this.read(name)).tokens;
  }

  async saveTokens(name: string, tokens: OAuthTokens): Promise<void> {
    const cur = await this.read(name);
    await this.write(name, { ...cur, tokens });
  }

  async deleteTokens(name: string): Promise<void> {
    const cur = await this.read(name);
    delete cur.tokens;
    await this.write(name, cur);
  }

  async getClientInfo(
    name: string
  ): Promise<OAuthClientInformationFull | undefined> {
    return (await this.read(name)).clientInfo;
  }

  async saveClientInfo(
    name: string,
    info: OAuthClientInformationFull
  ): Promise<void> {
    const cur = await this.read(name);
    await this.write(name, { ...cur, clientInfo: info });
  }

  async getCodeVerifier(name: string): Promise<string | undefined> {
    return (await this.read(name)).codeVerifier;
  }

  async saveCodeVerifier(name: string, verifier: string): Promise<void> {
    const cur = await this.read(name);
    await this.write(name, { ...cur, codeVerifier: verifier });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private filePath(name: string): string {
    // Allow [A-Za-z0-9_.-] only — same shape as agent ids. Servers with
    // exotic names should be renamed; the alternative is filesystem
    // escapes that vary across OS.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
      throw new Error(`Invalid MCP server name for token storage: ${name}`);
    }
    return path.join(this.dir, `${name}.json`);
  }

  private async read(name: string): Promise<FileShape> {
    const p = this.filePath(name);
    if (!fs.existsSync(p)) return {};
    try {
      const raw = await fs.promises.readFile(p, "utf-8");
      return JSON.parse(raw) as FileShape;
    } catch {
      // Corrupt token file — treat as empty rather than failing the connect
      // path. The SDK will trigger a fresh auth flow.
      return {};
    }
  }

  private async write(name: string, data: FileShape): Promise<void> {
    if (!fs.existsSync(this.dir)) {
      await fs.promises.mkdir(this.dir, { recursive: true });
    }
    const target = this.filePath(name);
    const tmp = target + ".tmp." + process.pid;
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      try {
        await fs.promises.chmod(tmp, 0o600);
      } catch {
        /* best-effort */
      }
    }
    await fs.promises.rename(tmp, target);
    if (process.platform !== "win32") {
      try {
        await fs.promises.chmod(target, 0o600);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * In-memory store — for tests and short-lived CLI commands that don't
 * need credential persistence.
 */
export class InMemoryMCPTokenStore implements MCPTokenStore {
  private map = new Map<string, FileShape>();

  async getTokens(name: string) {
    return this.map.get(name)?.tokens;
  }
  async saveTokens(name: string, tokens: OAuthTokens) {
    const cur = this.map.get(name) ?? {};
    this.map.set(name, { ...cur, tokens });
  }
  async deleteTokens(name: string) {
    const cur = this.map.get(name);
    if (cur) {
      delete cur.tokens;
      this.map.set(name, cur);
    }
  }
  async getClientInfo(name: string) {
    return this.map.get(name)?.clientInfo;
  }
  async saveClientInfo(name: string, info: OAuthClientInformationFull) {
    const cur = this.map.get(name) ?? {};
    this.map.set(name, { ...cur, clientInfo: info });
  }
  async getCodeVerifier(name: string) {
    return this.map.get(name)?.codeVerifier;
  }
  async saveCodeVerifier(name: string, verifier: string) {
    const cur = this.map.get(name) ?? {};
    this.map.set(name, { ...cur, codeVerifier: verifier });
  }
}
