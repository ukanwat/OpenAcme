import type { Browser, BrowserContext, Page } from "playwright-core";
import { connectOverCdp, isRecoverableDisconnect } from "./cdp.js";
import type { AcquiredBrowser, BrowserProvider } from "./providers/base.js";
import { refLocator } from "./refs.js";
import { ariaSnapshot } from "./snapshot.js";
import type {
  ActionResult,
  ClickCoordsParams,
  ClickParams,
  ConsoleEntry,
  ConsoleMessagesParams,
  ConsoleMessagesResult,
  DialogResult,
  DragParams,
  EvaluateParams,
  EvaluateResult,
  FileUploadParams,
  FillFormParams,
  FillFormResult,
  HandleDialogParams,
  HoverParams,
  NavHistoryResult,
  NavigateParams,
  NavigateResult,
  PdfResult,
  PressKeyParams,
  ResizeParams,
  ResizeResult,
  SaveAsPdfParams,
  ScreenshotParams,
  ScreenshotResult,
  SelectOptionParams,
  SelectOptionResult,
  SnapshotParams,
  SnapshotResult,
  TabId,
  TabInfo,
  TypeParams,
  WaitForParams,
} from "./types.js";

const MAX_CONSOLE_PER_PAGE = 200;

interface PerAgentTabs {
  next: number;
  byTargetId: Map<string, TabId>;
  byTabId: Map<TabId, string>;
}

interface PageState {
  console: ConsoleEntry[];
  dialogHandler: ((dialog: import("playwright-core").Dialog) => Promise<void>) | null;
}

interface AgentBrowserInstance {
  acquired: AcquiredBrowser;
  browser: Browser;
  agentTabs: PerAgentTabs;
  activeTargetId: string | null;
  pageState: WeakMap<Page, PageState>;
}

/**
 * Per-agent browser orchestrator. Each agent that calls a browser tool
 * gets its own session — a separate Chrome process for the local provider,
 * a separate cloud session for Browserbase / Browser-Use / Firecrawl.
 * Sessions are lazy and acquired on first tool call.
 *
 * Why per-agent: shared cookies cascade bans across the workforce, and
 * shared fingerprints get the whole org flagged on social-media-style
 * sites. Each agent is a distinct persona; the runtime should reflect that.
 */
export class BrowserManager {
  private readonly provider: BrowserProvider;
  private instances = new Map<string, AgentBrowserInstance>();
  private connecting = new Map<string, Promise<AgentBrowserInstance>>();

  constructor(opts: { provider: BrowserProvider }) {
    this.provider = opts.provider;
  }

  get providerName(): string {
    return this.provider.name;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  private async getInstance(agentId: string): Promise<AgentBrowserInstance> {
    if (!agentId) throw new Error("BrowserManager calls require an agentId");
    const existing = this.instances.get(agentId);
    if (existing && existing.browser.isConnected()) return existing;
    if (existing) {
      this.instances.delete(agentId);
      try {
        await existing.acquired.release();
      } catch {
        // best-effort
      }
    }
    const inflight = this.connecting.get(agentId);
    if (inflight) return inflight;
    const p = this.connectFor(agentId).finally(() => this.connecting.delete(agentId));
    this.connecting.set(agentId, p);
    return p;
  }

  private async connectFor(agentId: string): Promise<AgentBrowserInstance> {
    const acquired = await this.provider.acquire(agentId);
    let browser;
    try {
      browser = await connectOverCdp({
        wsUrl: acquired.cdpUrl,
        onDisconnected: (b) => {
          const inst = this.instances.get(agentId);
          if (inst && inst.browser === b) this.instances.delete(agentId);
        },
      });
    } catch (e) {
      // Avoid leaking the upstream session (Chrome process, cloud billing
      // window) when the initial CDP attach fails.
      try {
        await acquired.release();
      } catch {
        // best-effort
      }
      throw e;
    }
    const instance: AgentBrowserInstance = {
      acquired,
      browser,
      agentTabs: { next: 1, byTargetId: new Map(), byTabId: new Map() },
      activeTargetId: null,
      pageState: new WeakMap(),
    };
    this.instances.set(agentId, instance);
    return instance;
  }

  private async contextFor(agentId: string): Promise<{ inst: AgentBrowserInstance; ctx: BrowserContext }> {
    const inst = await this.getInstance(agentId);
    const contexts = inst.browser.contexts();
    if (contexts.length === 0) {
      throw new Error("No BrowserContext available on this agent's Chrome.");
    }
    return { inst, ctx: contexts[0]! };
  }

  /** Release one agent's browser session. Idempotent. */
  async closeAgent(agentId: string): Promise<void> {
    const inst = this.instances.get(agentId);
    if (inst) {
      this.instances.delete(agentId);
      try {
        await inst.browser.close();
      } catch {
        // best-effort
      }
    }
    try {
      await this.provider.releaseAgent(agentId);
    } catch {
      // best-effort
    }
  }

  /** Release every agent and shut down the provider. */
  async close(): Promise<void> {
    const ids = Array.from(this.instances.keys());
    await Promise.all(ids.map((id) => this.closeAgent(id)));
    try {
      await this.provider.releaseAll();
    } catch {
      // best-effort
    }
  }

  // ───────────────────────── per-page observation ─────────────────────────

  private observePage(inst: AgentBrowserInstance, page: Page): void {
    if (inst.pageState.has(page)) return;
    const state: PageState = { console: [], dialogHandler: null };
    inst.pageState.set(page, state);
    page.on("console", (msg) => {
      if (state.console.length >= MAX_CONSOLE_PER_PAGE) state.console.shift();
      state.console.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
        timestamp: new Date().toISOString(),
      });
    });
    page.on("pageerror", (err) => {
      if (state.console.length >= MAX_CONSOLE_PER_PAGE) state.console.shift();
      state.console.push({
        type: "error",
        text: err.message,
        timestamp: new Date().toISOString(),
      });
    });
  }

  // ───────────────────────── tab tracking ─────────────────────────

  private assignTabAlias(inst: AgentBrowserInstance, targetId: string): TabId {
    const existing = inst.agentTabs.byTargetId.get(targetId);
    if (existing) return existing;
    const id: TabId = `t${inst.agentTabs.next}`;
    inst.agentTabs.next += 1;
    inst.agentTabs.byTargetId.set(targetId, id);
    inst.agentTabs.byTabId.set(id, targetId);
    return id;
  }

  private trackPage(inst: AgentBrowserInstance, page: Page, targetId: string): TabId {
    this.observePage(inst, page);
    const tabId = this.assignTabAlias(inst, targetId);
    inst.activeTargetId = targetId;
    page.once("close", () => {
      inst.agentTabs.byTargetId.delete(targetId);
      inst.agentTabs.byTabId.delete(tabId);
      if (inst.activeTargetId === targetId) inst.activeTargetId = null;
    });
    return tabId;
  }

  private async targetIdOf(page: Page): Promise<string> {
    const session = await page.context().newCDPSession(page);
    try {
      const info = (await session.send("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      const id = info.targetInfo?.targetId;
      if (!id) throw new Error("Target.getTargetInfo returned no targetId");
      return id;
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private async findPageByTargetId(ctx: BrowserContext, targetId: string): Promise<Page | null> {
    for (const p of ctx.pages()) {
      try {
        const tid = await this.targetIdOf(p);
        if (tid === targetId) return p;
      } catch {
        // page may have closed mid-iteration
      }
    }
    return null;
  }

  private async resolvePage(
    agentId: string,
    tabId: TabId | undefined,
    opts: { createIfNone: boolean }
  ): Promise<{ inst: AgentBrowserInstance; page: Page; tabId: TabId; targetId: string }> {
    const { inst, ctx } = await this.contextFor(agentId);
    let targetId: string | null | undefined;
    if (tabId) {
      targetId = inst.agentTabs.byTabId.get(tabId);
      if (!targetId) throw new Error(`Tab ${tabId} not found for this agent.`);
    } else {
      targetId = inst.activeTargetId;
    }

    if (targetId) {
      const page = await this.findPageByTargetId(ctx, targetId);
      if (page) {
        this.observePage(inst, page);
        const resolvedTabId = inst.agentTabs.byTargetId.get(targetId)!;
        return { inst, page, tabId: resolvedTabId, targetId };
      }
      inst.agentTabs.byTargetId.delete(targetId);
      if (inst.activeTargetId === targetId) inst.activeTargetId = null;
      targetId = null;
    }

    if (!opts.createIfNone) {
      throw new Error("No tabs open for this agent. Call browser_navigate first to open one.");
    }
    const page = await ctx.newPage();
    const newTargetId = await this.targetIdOf(page);
    const newTabId = this.trackPage(inst, page, newTargetId);
    return { inst, page, tabId: newTabId, targetId: newTargetId };
  }

  /**
   * Run an action with one-shot reconnect on transient CDP disconnects.
   * Drops the agent's instance + cloud session before retrying so we
   * don't reuse a server-side session that the provider already killed.
   */
  private async withReconnect<T>(
    agentId: string,
    tabId: TabId | undefined,
    opts: { createIfNone: boolean },
    fn: (page: Page, ids: { tabId: TabId; targetId: string }) => Promise<T>
  ): Promise<T> {
    try {
      const r = await this.resolvePage(agentId, tabId, opts);
      return await fn(r.page, { tabId: r.tabId, targetId: r.targetId });
    } catch (e) {
      if (!isRecoverableDisconnect(e)) throw e;
      await this.closeAgent(agentId);
      const r = await this.resolvePage(agentId, tabId, opts);
      return await fn(r.page, { tabId: r.tabId, targetId: r.targetId });
    }
  }

  // ───────────────────────── public API ─────────────────────────

  async navigate(agentId: string, p: NavigateParams): Promise<NavigateResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: true }, async (page, ids) => {
      await page.goto(p.url, { waitUntil: "domcontentloaded" });
      const [title, url, snapshot] = await Promise.all([
        page.title(),
        Promise.resolve(page.url()),
        ariaSnapshot(page),
      ]);
      return { tabId: ids.tabId, url, title, snapshot };
    });
  }

  async snapshot(agentId: string, p: SnapshotParams): Promise<SnapshotResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const snapshot = await ariaSnapshot(page);
      return { tabId: ids.tabId, url: page.url(), snapshot };
    });
  }

  async click(agentId: string, p: ClickParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await refLocator(page, p.ref).click();
      return { tabId: ids.tabId };
    });
  }

  async type(agentId: string, p: TypeParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const loc = refLocator(page, p.ref);
      await loc.fill(p.text);
      if (p.submit) await loc.press("Enter");
      return { tabId: ids.tabId };
    });
  }

  async pressKey(agentId: string, p: PressKeyParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.keyboard.press(p.key);
      return { tabId: ids.tabId };
    });
  }

  async takeScreenshot(agentId: string, p: ScreenshotParams): Promise<ScreenshotResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const buf = await page.screenshot({ fullPage: !!p.fullPage, type: "png" });
      return {
        tabId: ids.tabId,
        pngBase64: buf.toString("base64"),
        mediaType: "image/png",
      };
    });
  }

  async waitFor(agentId: string, p: WaitForParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      if (p.text) {
        await page.getByText(p.text, { exact: false }).first().waitFor({ timeout: 30_000 });
      } else if (p.textGone) {
        await page
          .getByText(p.textGone, { exact: false })
          .first()
          .waitFor({ state: "hidden", timeout: 30_000 });
      } else if (p.timeMs && p.timeMs > 0) {
        await page.waitForTimeout(p.timeMs);
      }
      return { tabId: ids.tabId };
    });
  }

  async evaluate(agentId: string, p: EvaluateParams): Promise<EvaluateResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const result = await page.evaluate(p.function as unknown as string);
      return { tabId: ids.tabId, result };
    });
  }

  async consoleMessages(
    agentId: string,
    p: ConsoleMessagesParams
  ): Promise<ConsoleMessagesResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const { inst } = await this.contextFor(agentId);
      const state = inst.pageState.get(page);
      const messages = state ? [...state.console] : [];
      if (p.clear && state) state.console = [];
      return { tabId: ids.tabId, messages };
    });
  }

  // ── tabs ──

  async tabsList(agentId: string): Promise<TabInfo[]> {
    const { inst, ctx } = await this.contextFor(agentId);
    const out: TabInfo[] = [];
    for (const page of ctx.pages()) {
      let targetId: string;
      try {
        targetId = await this.targetIdOf(page);
      } catch {
        continue;
      }
      const tabId = inst.agentTabs.byTargetId.get(targetId);
      if (!tabId) continue;
      out.push({
        tabId,
        url: page.url(),
        title: await page.title().catch(() => ""),
        active: targetId === inst.activeTargetId,
      });
    }
    out.sort((a, b) => {
      const na = Number.parseInt(a.tabId.slice(1), 10);
      const nb = Number.parseInt(b.tabId.slice(1), 10);
      return na - nb;
    });
    return out;
  }

  async tabsNew(agentId: string, p: { url?: string }): Promise<TabInfo> {
    const { inst, ctx } = await this.contextFor(agentId);
    const page = await ctx.newPage();
    if (p.url) await page.goto(p.url, { waitUntil: "domcontentloaded" });
    const targetId = await this.targetIdOf(page);
    const tabId = this.trackPage(inst, page, targetId);
    return {
      tabId,
      url: page.url(),
      title: await page.title().catch(() => ""),
      active: true,
    };
  }

  async tabsClose(agentId: string, p: { tabId: TabId }): Promise<void> {
    const { inst, ctx } = await this.contextFor(agentId);
    const targetId = inst.agentTabs.byTabId.get(p.tabId);
    if (!targetId) throw new Error(`Tab ${p.tabId} not found for this agent.`);
    const page = await this.findPageByTargetId(ctx, targetId);
    if (page) {
      // page.close() fires the page.once("close") handler from trackPage,
      // which drops the alias maps + activeTargetId for us.
      await page.close();
    } else {
      inst.agentTabs.byTargetId.delete(targetId);
      inst.agentTabs.byTabId.delete(p.tabId);
      if (inst.activeTargetId === targetId) inst.activeTargetId = null;
    }
  }

  async tabsSelect(agentId: string, p: { tabId: TabId }): Promise<TabInfo> {
    const { inst, ctx } = await this.contextFor(agentId);
    const targetId = inst.agentTabs.byTabId.get(p.tabId);
    if (!targetId) throw new Error(`Tab ${p.tabId} not found for this agent.`);
    const page = await this.findPageByTargetId(ctx, targetId);
    if (!page) {
      inst.agentTabs.byTargetId.delete(targetId);
      inst.agentTabs.byTabId.delete(p.tabId);
      throw new Error(`Tab ${p.tabId} is no longer open.`);
    }
    inst.activeTargetId = targetId;
    await page.bringToFront().catch(() => {});
    return {
      tabId: p.tabId,
      url: page.url(),
      title: await page.title().catch(() => ""),
      active: true,
    };
  }

  // ── consolidated `act` verbs ──

  async hover(agentId: string, p: HoverParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await refLocator(page, p.ref).hover();
      return { tabId: ids.tabId };
    });
  }

  async drag(agentId: string, p: DragParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await refLocator(page, p.startRef).dragTo(refLocator(page, p.endRef));
      return { tabId: ids.tabId };
    });
  }

  async selectOption(agentId: string, p: SelectOptionParams): Promise<SelectOptionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const selected = await refLocator(page, p.ref).selectOption(p.values);
      return { tabId: ids.tabId, selected };
    });
  }

  async fillForm(agentId: string, p: FillFormParams): Promise<FillFormResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      for (const f of p.fields) {
        await refLocator(page, f.ref).fill(f.value);
      }
      return { tabId: ids.tabId, filled: p.fields.length };
    });
  }

  async fileUpload(agentId: string, p: FileUploadParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await refLocator(page, p.ref).setInputFiles(p.paths);
      return { tabId: ids.tabId };
    });
  }

  async handleDialog(agentId: string, p: HandleDialogParams): Promise<DialogResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          page.off("dialog", onDialog);
          reject(new Error("Timed out waiting for a dialog"));
        }, 30_000);
        const onDialog = async (dialog: import("playwright-core").Dialog) => {
          clearTimeout(timer);
          try {
            if (p.accept) {
              await dialog.accept(p.promptText ?? undefined);
            } else {
              await dialog.dismiss();
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        };
        page.once("dialog", onDialog);
      });
      return { tabId: ids.tabId, result: p.accept ? "accepted" : "dismissed" };
    });
  }

  async resize(agentId: string, p: ResizeParams): Promise<ResizeResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.setViewportSize({ width: p.width, height: p.height });
      return { tabId: ids.tabId, width: p.width, height: p.height };
    });
  }

  async navigateBack(agentId: string, p: { tabId?: TabId }): Promise<NavHistoryResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.goBack({ waitUntil: "domcontentloaded" });
      return { tabId: ids.tabId, url: page.url() };
    });
  }

  async navigateForward(agentId: string, p: { tabId?: TabId }): Promise<NavHistoryResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.goForward({ waitUntil: "domcontentloaded" });
      return { tabId: ids.tabId, url: page.url() };
    });
  }

  async saveAsPdf(agentId: string, p: SaveAsPdfParams): Promise<PdfResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const filename = p.filename ?? `browser-${ids.tabId}-${Date.now()}.pdf`;
      const outPath = filename.includes("/") ? filename : `/tmp/${filename}`;
      await page.pdf({ path: outPath, format: "Letter" });
      return { tabId: ids.tabId, path: outPath };
    });
  }

  async clickCoords(agentId: string, p: ClickCoordsParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.mouse.click(p.x, p.y);
      return { tabId: ids.tabId };
    });
  }
}
