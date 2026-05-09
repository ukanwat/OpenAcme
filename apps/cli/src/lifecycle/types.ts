export interface ServiceStatus {
  running: boolean;
  pid?: number;
  startedAt?: Date;
  unitInstalled: boolean;
}

export interface InstallOpts {
  binPath: string;
  nodePath: string;
  dataDir: string;
  logPath: string;
  host: string;
  port: number;
}

export interface PlatformLifecycle {
  /** Idempotent: write the service unit if missing or content has changed. */
  installUnit(opts: InstallOpts): Promise<{ wrote: boolean; path: string }>;
  uninstallUnit(): Promise<void>;
  startService(): Promise<void>;
  stopService(): Promise<void>;
  status(): Promise<ServiceStatus>;
  unitPath(): string;
  /** Human label, e.g. "launchd", "systemd-user", "no-service". */
  kind: string;
}

export class NoSystemdError extends Error {
  constructor() {
    super("systemd not detected at /run/systemd/system");
    this.name = "NoSystemdError";
  }
}
