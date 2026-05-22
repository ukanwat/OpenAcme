/** Per-agent stable tab alias (`t1`, `t2`, ...). Opaque to the model. */
export type TabId = string;

/**
 * Per-agent browser config — namespaced by provider so each backend's
 * settings stay grouped. Resolved by `BrowserManager` at acquire time
 * and forwarded to the active provider. Each agent that uses a browser
 * gets its own profile binding for cookie isolation, mirroring how
 * local Chrome profiles are scoped under `<agentDir>/browser-profiles/`.
 *
 * Set in AGENT.md frontmatter:
 *
 *   browser:
 *     browserUse:
 *       profileId: 6c0cbf15-...
 *     firecrawl:
 *       profileName: redditor
 *     browserbase:
 *       contextId: 9af1...
 *
 * Only the sub-block matching the workforce-active provider is consulted.
 */
export interface AgentBrowserOverrides {
  browserUse?: { profileId?: string };
  firecrawl?: { profileName?: string };
  browserbase?: { contextId?: string };
}

export interface BrowserConfig {
  enabled: boolean;
  provider: "local" | "browserbase" | "browser-use" | "firecrawl";
  localBrowser: "chromium" | "camoufox";
  executablePath?: string;
  headless: boolean;
  noSandbox: boolean;
}

export interface TabInfo {
  tabId: TabId;
  url: string;
  title: string;
  active: boolean;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  location?: { url: string; lineNumber: number; columnNumber: number };
  timestamp: string;
}

export interface NavigateParams {
  url: string;
  tabId?: TabId;
}

export interface SnapshotParams {
  tabId?: TabId;
  selector?: string;
}

export interface ClickParams {
  element: string;
  ref: string;
  tabId?: TabId;
}

export interface TypeParams {
  element: string;
  ref: string;
  text: string;
  submit?: boolean;
  tabId?: TabId;
}

export interface PressKeyParams {
  key: string;
  tabId?: TabId;
}

export interface ScreenshotParams {
  fullPage?: boolean;
  tabId?: TabId;
}

export interface WaitForParams {
  text?: string;
  textGone?: string;
  timeMs?: number;
  tabId?: TabId;
}

export interface EvaluateParams {
  function: string;
  tabId?: TabId;
}

export interface ConsoleMessagesParams {
  clear?: boolean;
  tabId?: TabId;
}

export interface NavigateResult {
  tabId: TabId;
  url: string;
  title: string;
  snapshot: string;
}

export interface SnapshotResult {
  tabId: TabId;
  url: string;
  snapshot: string;
}

export interface ActionResult {
  tabId: TabId;
  /** Post-action aria-snapshot. Present for interactions that can mutate the
   *  DOM (click/type/hover/drag/select/fill/upload). Omitted for actions
   *  that don't (resize, dialog handling, save_as_pdf). Mirrors Microsoft
   *  playwright-mcp's `setIncludeSnapshot()` convention. */
  snapshot?: string;
}

export interface ScreenshotResult {
  tabId: TabId;
  pngBase64: string;
  mediaType: "image/png";
}

export interface EvaluateResult {
  tabId: TabId;
  result: unknown;
}

export interface ConsoleMessagesResult {
  tabId: TabId;
  messages: ConsoleEntry[];
}

export interface HoverParams {
  element: string;
  ref: string;
  tabId?: TabId;
}

export interface DragParams {
  startElement: string;
  startRef: string;
  endElement: string;
  endRef: string;
  tabId?: TabId;
}

export interface SelectOptionParams {
  element: string;
  ref: string;
  values: string[];
  tabId?: TabId;
}

export interface FillFormField {
  element: string;
  ref: string;
  value: string;
}

export interface FillFormParams {
  fields: FillFormField[];
  tabId?: TabId;
}

export interface FileUploadParams {
  ref: string;
  paths: string[];
  tabId?: TabId;
}

export interface HandleDialogParams {
  accept: boolean;
  promptText?: string;
  tabId?: TabId;
}

export interface ResizeParams {
  width: number;
  height: number;
  tabId?: TabId;
}

export interface SaveAsPdfParams {
  filename?: string;
  tabId?: TabId;
}

export interface ClickCoordsParams {
  x: number;
  y: number;
  tabId?: TabId;
}

export interface SelectOptionResult {
  tabId: TabId;
  selected: string[];
  snapshot?: string;
}

export interface FillFormResult {
  tabId: TabId;
  filled: number;
  snapshot?: string;
}

export interface DialogResult {
  tabId: TabId;
  result: "accepted" | "dismissed";
}

export interface ResizeResult {
  tabId: TabId;
  width: number;
  height: number;
}

export interface NavHistoryResult {
  tabId: TabId;
  url: string;
  snapshot?: string;
}

export interface PdfResult {
  tabId: TabId;
  path: string;
}
