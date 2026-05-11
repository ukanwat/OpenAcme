import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  killChrome,
  launchChrome,
  resolveExecutableOrThrow,
  resolveUserDataDir,
  type RunningChrome,
} from "./chrome.js";
import { connectOverCdp, isRecoverableDisconnect } from "./cdp.js";
import { refLocator } from "./refs.js";
import { ariaSnapshot } from "./snapshot.js";
import type {
  BrowserConfig,
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
  ActionResult,
} from "./types.js";

const MAX_CONSOLE_PER_PAGE = 200;

interface PerAgentTabs {
  next: number;
  byTargetId: Map<string, TabId>; // targetId -> "tN"
  byTabId: Map<TabId, string>; // "tN" -> targetId
}

interface PageState {
  console: ConsoleEntry[];
  dialogHandler: ((dialog: import("playwright-core").Dialog) => Promise<void>) | null;
}

/**
 * Owns the single managed Chrome process for the OpenAcme workforce.
 *
 * One Chrome under `<dataDir>/browser-profile/`; one shared default
 * `BrowserContext` so all agents share cookies / login state. Tabs are
 * partitioned per-agent: each agent gets its own `t1`, `t2`, ... alias
 * space. Cross-agent tab access is refused.
 *
 * Lazy: nothing happens until the first tool call. CDP disconnect on
 * sleep/wake is recovered transparently — `cachedBrowser` is invalidated
 * by the `disconnected` listener and re-established on next call.
 */
export class BrowserManager {
  private readonly userDataDir: string;
  private readonly cfg: BrowserConfig;

  private running: RunningChrome | null = null;
  private cachedBrowser: Browser | null = null;
  private connectingPromise: Promise<Browser> | null = null;
  private launchingPromise: Promise<RunningChrome> | null = null;

  // Tab ownership: targetId -> owning agentId
  private tabOwnership = new Map<string, string>();
  // Per-agent alias spaces (tN ids stable within an agent)
  private agentTabs = new Map<string, PerAgentTabs>();
  // The agent's currently-active tab
  private activeTabByAgent = new Map<string, string>(); // agentId -> targetId
  // Per-page transient state (console buffer, pending dialog policy)
  private pageState = new WeakMap<Page, PageState>();

  constructor(opts: { dataDir: string; config: BrowserConfig }) {
    this.userDataDir = resolveUserDataDir(opts.dataDir);
    this.cfg = opts.config;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  private async ensureChrome(): Promise<RunningChrome> {
    if (this.running && this.running.proc.exitCode === null) return this.running;
    if (this.launchingPromise) return this.launchingPromise;
    const exe = resolveExecutableOrThrow(this.cfg);
    this.launchingPromise = launchChrome({
      exe,
      cdpPort: this.cfg.port,
      userDataDir: this.userDataDir,
      headless: this.cfg.headless,
      noSandbox: this.cfg.noSandbox,
    })
      .then((r) => {
        r.proc.once("exit", () => {
          if (this.running === r) {
            this.running = null;
            this.cachedBrowser = null;
            this.resetAllTabState();
          }
        });
        this.running = r;
        return r;
      })
      .finally(() => {
        this.launchingPromise = null;
      });
    return this.launchingPromise;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.cachedBrowser) return this.cachedBrowser;
    if (this.connectingPromise) return this.connectingPromise;
    this.connectingPromise = this.connectFresh().finally(() => {
      this.connectingPromise = null;
    });
    return this.connectingPromise;
  }

  private async connectFresh(): Promise<Browser> {
    const running = await this.ensureChrome();
    const browser = await connectOverCdp({
      wsUrl: running.cdpUrl,
      onDisconnected: (b) => {
        if (this.cachedBrowser === b) this.cachedBrowser = null;
      },
    });
    this.cachedBrowser = browser;
    return browser;
  }

  private async sharedContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      // Should never happen with connectOverCDP — Chrome always exposes
      // the default context — but defensive.
      throw new Error("No BrowserContext available on the connected Chrome.");
    }
    const ctx = contexts[0]!;
    return ctx;
  }

  private resetAllTabState(): void {
    this.tabOwnership.clear();
    this.agentTabs.clear();
    this.activeTabByAgent.clear();
  }

  async close(): Promise<void> {
    if (this.cachedBrowser) {
      try {
        await this.cachedBrowser.close();
      } catch {
        // ignore — we're shutting down
      }
      this.cachedBrowser = null;
    }
    if (this.running) {
      await killChrome(this.running);
      this.running = null;
    }
    this.resetAllTabState();
  }

  // ───────────────────────── per-page observation ─────────────────────────

  private observePage(page: Page): void {
    if (this.pageState.has(page)) return;
    const state: PageState = { console: [], dialogHandler: null };
    this.pageState.set(page, state);
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

  // ───────────────────────── tab ownership ─────────────────────────

  private agentTabsFor(agentId: string): PerAgentTabs {
    let s = this.agentTabs.get(agentId);
    if (!s) {
      s = { next: 1, byTargetId: new Map(), byTabId: new Map() };
      this.agentTabs.set(agentId, s);
    }
    return s;
  }

  private assignTabAlias(agentId: string, targetId: string): TabId {
    const s = this.agentTabsFor(agentId);
    const existing = s.byTargetId.get(targetId);
    if (existing) return existing;
    const id: TabId = `t${s.next}`;
    s.next += 1;
    s.byTargetId.set(targetId, id);
    s.byTabId.set(id, targetId);
    this.tabOwnership.set(targetId, agentId);
    return id;
  }

  private trackPageForAgent(agentId: string, page: Page, targetId: string): TabId {
    this.observePage(page);
    const tabId = this.assignTabAlias(agentId, targetId);
    this.activeTabByAgent.set(agentId, targetId);
    page.once("close", () => {
      this.releaseTab(targetId);
    });
    return tabId;
  }

  private releaseTab(targetId: string): void {
    const owner = this.tabOwnership.get(targetId);
    if (!owner) return;
    this.tabOwnership.delete(targetId);
    const s = this.agentTabs.get(owner);
    if (s) {
      const alias = s.byTargetId.get(targetId);
      if (alias) {
        s.byTabId.delete(alias);
        s.byTargetId.delete(targetId);
      }
    }
    if (this.activeTabByAgent.get(owner) === targetId) {
      this.activeTabByAgent.delete(owner);
    }
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

  /**
   * Resolve the Page for `tabId` (or the active tab if omitted) and verify
   * the agent owns it. Throws on missing tab / cross-agent access.
   */
  private async resolvePage(
    agentId: string,
    tabId: TabId | undefined,
    opts: { createIfNone: boolean }
  ): Promise<{ page: Page; tabId: TabId; targetId: string }> {
    const s = this.agentTabsFor(agentId);
    let targetId: string | undefined;
    if (tabId) {
      targetId = s.byTabId.get(tabId);
      if (!targetId) {
        throw new Error(`Tab ${tabId} not found for this agent.`);
      }
    } else {
      targetId = this.activeTabByAgent.get(agentId);
    }

    const ctx = await this.sharedContext();

    if (targetId) {
      const page = await this.findPageByTargetId(ctx, targetId);
      if (page) {
        this.observePage(page);
        const resolvedTabId = s.byTargetId.get(targetId)!;
        return { page, tabId: resolvedTabId, targetId };
      }
      // The target id we remember is gone (page closed externally,
      // Chrome respawned, etc.). Clean up and fall through.
      this.releaseTab(targetId);
      targetId = undefined;
    }

    if (!opts.createIfNone) {
      throw new Error(
        "No tabs owned by this agent. Call browser_navigate first to open one."
      );
    }
    const page = await ctx.newPage();
    const newTargetId = await this.targetIdOf(page);
    const newTabId = this.trackPageForAgent(agentId, page, newTargetId);
    return { page, tabId: newTabId, targetId: newTargetId };
  }

  private async findPageByTargetId(
    ctx: BrowserContext,
    targetId: string
  ): Promise<Page | null> {
    for (const p of ctx.pages()) {
      try {
        const tid = await this.targetIdOf(p);
        if (tid === targetId) return p;
      } catch {
        // ignore — the page may have closed mid-iteration
      }
    }
    return null;
  }

  /**
   * Run an action with one-shot reconnect on transient CDP disconnects.
   * The action gets a fresh `page` resolution on retry.
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
      // Invalidate connection + tab state and retry once.
      this.cachedBrowser = null;
      const r = await this.resolvePage(agentId, tabId, opts);
      return await fn(r.page, { tabId: r.tabId, targetId: r.targetId });
    }
  }

  // ───────────────────────── public API ─────────────────────────

  async navigate(agentId: string, p: NavigateParams): Promise<NavigateResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: true },
      async (page, ids) => {
        await page.goto(p.url, { waitUntil: "domcontentloaded" });
        const [title, url, snapshot] = await Promise.all([
          page.title(),
          Promise.resolve(page.url()),
          ariaSnapshot(page),
        ]);
        return { tabId: ids.tabId, url, title, snapshot };
      }
    );
  }

  async snapshot(agentId: string, p: SnapshotParams): Promise<SnapshotResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        const snapshot = await ariaSnapshot(page);
        return { tabId: ids.tabId, url: page.url(), snapshot };
      }
    );
  }

  async click(agentId: string, p: ClickParams): Promise<ActionResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        await refLocator(page, p.ref).click();
        return { tabId: ids.tabId };
      }
    );
  }

  async type(agentId: string, p: TypeParams): Promise<ActionResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        const loc = refLocator(page, p.ref);
        await loc.fill(p.text);
        if (p.submit) await loc.press("Enter");
        return { tabId: ids.tabId };
      }
    );
  }

  async pressKey(agentId: string, p: PressKeyParams): Promise<ActionResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        await page.keyboard.press(p.key);
        return { tabId: ids.tabId };
      }
    );
  }

  async takeScreenshot(
    agentId: string,
    p: ScreenshotParams
  ): Promise<ScreenshotResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        const buf = await page.screenshot({ fullPage: !!p.fullPage, type: "png" });
        return {
          tabId: ids.tabId,
          pngBase64: buf.toString("base64"),
          mediaType: "image/png",
        };
      }
    );
  }

  async waitFor(agentId: string, p: WaitForParams): Promise<ActionResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        if (p.text) {
          await page
            .getByText(p.text, { exact: false })
            .first()
            .waitFor({ timeout: 30_000 });
        } else if (p.textGone) {
          await page
            .getByText(p.textGone, { exact: false })
            .first()
            .waitFor({ state: "hidden", timeout: 30_000 });
        } else if (p.timeMs && p.timeMs > 0) {
          await page.waitForTimeout(p.timeMs);
        }
        return { tabId: ids.tabId };
      }
    );
  }

  async evaluate(agentId: string, p: EvaluateParams): Promise<EvaluateResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        // `function` is treated as an expression body — the model writes
        // something like `document.title` or `(() => Array.from(document.images).length)()`.
        const result = await page.evaluate(p.function as unknown as string);
        return { tabId: ids.tabId, result };
      }
    );
  }

  async consoleMessages(
    agentId: string,
    p: ConsoleMessagesParams
  ): Promise<ConsoleMessagesResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        const state = this.pageState.get(page);
        const messages = state ? [...state.console] : [];
        if (p.clear && state) state.console = [];
        return { tabId: ids.tabId, messages };
      }
    );
  }

  // ── tabs ──

  async tabsList(agentId: string): Promise<TabInfo[]> {
    const ctx = await this.sharedContext();
    const s = this.agentTabsFor(agentId);
    const active = this.activeTabByAgent.get(agentId);
    const out: TabInfo[] = [];
    for (const page of ctx.pages()) {
      let targetId: string;
      try {
        targetId = await this.targetIdOf(page);
      } catch {
        continue;
      }
      const tabId = s.byTargetId.get(targetId);
      if (!tabId) continue;
      out.push({
        tabId,
        url: page.url(),
        title: await page.title().catch(() => ""),
        active: targetId === active,
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
    const ctx = await this.sharedContext();
    const page = await ctx.newPage();
    if (p.url) await page.goto(p.url, { waitUntil: "domcontentloaded" });
    const targetId = await this.targetIdOf(page);
    const tabId = this.trackPageForAgent(agentId, page, targetId);
    return {
      tabId,
      url: page.url(),
      title: await page.title().catch(() => ""),
      active: true,
    };
  }

  async tabsClose(agentId: string, p: { tabId: TabId }): Promise<void> {
    const s = this.agentTabsFor(agentId);
    const targetId = s.byTabId.get(p.tabId);
    if (!targetId) throw new Error(`Tab ${p.tabId} not found for this agent.`);
    const ctx = await this.sharedContext();
    const page = await this.findPageByTargetId(ctx, targetId);
    if (page) await page.close();
    this.releaseTab(targetId);
  }

  async tabsSelect(agentId: string, p: { tabId: TabId }): Promise<TabInfo> {
    const s = this.agentTabsFor(agentId);
    const targetId = s.byTabId.get(p.tabId);
    if (!targetId) throw new Error(`Tab ${p.tabId} not found for this agent.`);
    const ctx = await this.sharedContext();
    const page = await this.findPageByTargetId(ctx, targetId);
    if (!page) {
      this.releaseTab(targetId);
      throw new Error(`Tab ${p.tabId} is no longer open.`);
    }
    this.activeTabByAgent.set(agentId, targetId);
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
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        await refLocator(page, p.ref).hover();
        return { tabId: ids.tabId };
      }
    );
  }

  async drag(agentId: string, p: DragParams): Promise<ActionResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        await refLocator(page, p.startRef).dragTo(refLocator(page, p.endRef));
        return { tabId: ids.tabId };
      }
    );
  }

  async selectOption(
    agentId: string,
    p: SelectOptionParams
  ): Promise<SelectOptionResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        const selected = await refLocator(page, p.ref).selectOption(p.values);
        return { tabId: ids.tabId, selected };
      }
    );
  }

  async fillForm(agentId: string, p: FillFormParams): Promise<FillFormResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        for (const f of p.fields) {
          await refLocator(page, f.ref).fill(f.value);
        }
        return { tabId: ids.tabId, filled: p.fields.length };
      }
    );
  }

  async fileUpload(agentId: string, p: FileUploadParams): Promise<ActionResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        await refLocator(page, p.ref).setInputFiles(p.paths);
        return { tabId: ids.tabId };
      }
    );
  }

  /**
   * Arm a one-shot dialog handler on the page. The handler resolves the
   * NEXT dialog event with accept/dismiss + optional prompt text.
   */
  async handleDialog(
    agentId: string,
    p: HandleDialogParams
  ): Promise<DialogResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
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
        return {
          tabId: ids.tabId,
          result: p.accept ? "accepted" : "dismissed",
        };
      }
    );
  }

  async resize(agentId: string, p: ResizeParams): Promise<ResizeResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        await page.setViewportSize({ width: p.width, height: p.height });
        return { tabId: ids.tabId, width: p.width, height: p.height };
      }
    );
  }

  async navigateBack(
    agentId: string,
    p: { tabId?: TabId }
  ): Promise<NavHistoryResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        await page.goBack({ waitUntil: "domcontentloaded" });
        return { tabId: ids.tabId, url: page.url() };
      }
    );
  }

  async navigateForward(
    agentId: string,
    p: { tabId?: TabId }
  ): Promise<NavHistoryResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        await page.goForward({ waitUntil: "domcontentloaded" });
        return { tabId: ids.tabId, url: page.url() };
      }
    );
  }

  async saveAsPdf(agentId: string, p: SaveAsPdfParams): Promise<PdfResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        const filename = p.filename ?? `browser-${ids.tabId}-${Date.now()}.pdf`;
        const outPath = filename.includes("/")
          ? filename
          : `/tmp/${filename}`;
        await page.pdf({ path: outPath, format: "Letter" });
        return { tabId: ids.tabId, path: outPath };
      }
    );
  }

  async clickCoords(
    agentId: string,
    p: ClickCoordsParams
  ): Promise<ActionResult> {
    return this.withReconnect(
      agentId,
      p.tabId,
      { createIfNone: false },
      async (page, ids) => {
        await page.mouse.click(p.x, p.y);
        return { tabId: ids.tabId };
      }
    );
  }
}
