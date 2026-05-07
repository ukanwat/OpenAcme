import * as p from "@clack/prompts";
import { resolveDataDir } from "@openacme/config";
import { clearEntry } from "@openacme/auth";

export interface LogoutOptions {
  provider?: "openai" | "anthropic";
  dataDir?: string;
}

export async function logoutCommand(opts: LogoutOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  let provider = opts.provider;
  if (!provider) {
    const choice = await p.select({
      message: "Sign out from which provider?",
      options: [
        { value: "openai", label: "OpenAI (ChatGPT)" },
        { value: "anthropic", label: "Anthropic (Claude)" },
      ],
    });
    if (p.isCancel(choice)) {
      p.cancel("Logout cancelled.");
      return;
    }
    provider = choice as "openai" | "anthropic";
  }

  clearEntry(dataDir, provider);
  p.outro(`Signed out from ${provider}. Tokens removed from ${dataDir}/auth.json.`);
}
