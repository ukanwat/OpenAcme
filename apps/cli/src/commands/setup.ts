import * as p from "@clack/prompts";
import gradient from "gradient-string";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveDataDir, saveConfig, ConfigSchema, type Provider } from "@openacme/config";
import { listProviders } from "@openacme/llm-provider";

/**
 * Interactive setup wizard — configure provider, API key, and create first agent.
 */
export async function setupCommand(opts: { dataDir?: string }) {
  const dataDir = resolveDataDir(opts.dataDir);

  console.log();
  const coolGradient = gradient(["#0ea5e9", "#7dd3fc", "#ffffff"]);
  p.intro(coolGradient("OpenAcme Setup"));

  p.note(`Data directory: ${dataDir}`, "Configuration");

  // Choose provider
  const providers = listProviders();

  const results = await p.group(
    {
      provider: () =>
        p.select({
          message: "Choose your LLM provider",
          options: providers.map((prov) => ({
            value: prov.id,
            label: prov.name,
            hint: prov.requiresApiKey ? prov.envVar : "no key needed",
          })),
        }),

      apiKey: ({ results }) => {
        const selected = providers.find((prov) => prov.id === results.provider);
        if (!selected?.requiresApiKey) {
          return Promise.resolve(undefined);
        }
        return p.text({
          message: `Enter your ${selected.envVar}`,
          placeholder: "sk-...",
          validate: (value) => {
            if (!value || !value.trim()) {
              return "API key is required for this provider";
            }
            if (value.trim().length < 10) {
              return "API key seems too short";
            }
            return undefined;
          },
        });
      },

      model: ({ results }) => {
        const defaultModel =
          results.provider === "openrouter"
            ? "anthropic/claude-sonnet-4-20250514"
            : results.provider === "openai"
              ? "gpt-4o"
              : results.provider === "anthropic"
                ? "claude-sonnet-4-20250514"
                : results.provider === "google"
                  ? "gemini-2.5-flash"
                  : results.provider === "ollama"
                    ? "llama3.2"
                    : "gpt-4o";

        return p.text({
          message: "Model name",
          placeholder: defaultModel,
          defaultValue: defaultModel,
        });
      },

      confirm: () =>
        p.confirm({
          message: "Save configuration?",
          initialValue: true,
        }),
    },
    {
      onCancel: () => {
        p.cancel("Setup cancelled.");
        process.exit(0);
      },
    }
  );

  if (!results.confirm) {
    p.cancel("Setup cancelled.");
    return;
  }

  const provider = providers.find((prov) => prov.id === results.provider)!;
  const apiKey = results.apiKey as string | undefined;
  const model = results.model as string;

  const s = p.spinner();
  s.start("Saving configuration...");

  // Save .env
  if (apiKey?.trim() && provider.envVar) {
    const envPath = path.join(dataDir, ".env");
    const envLine = `${provider.envVar}=${apiKey.trim()}\n`;

    if (fs.existsSync(envPath)) {
      const existing = fs.readFileSync(envPath, "utf-8");
      if (!existing.includes(provider.envVar)) {
        fs.appendFileSync(envPath, envLine);
      }
    } else {
      fs.writeFileSync(envPath, envLine);
    }
  }

  // Save config.yaml
  const config = ConfigSchema.parse({
    dataDir,
    model: {
      provider: provider.id as Provider,
      model,
      baseUrl: provider.defaultBaseUrl,
    },
    agents: [
      {
        id: "default",
        name: "Default Agent",
        model: {
          provider: provider.id as Provider,
          model,
          baseUrl: provider.defaultBaseUrl,
        },
        persona:
          "You are a helpful AI assistant. You can execute shell commands, read and write files, and search the filesystem to help users with their tasks.",
        tools: ["shell", "read_file", "write_file", "list_files", "search_files"],
        mcpServers: {},
        skills: [],
      },
    ],
  });

  saveConfig(config);

  s.stop("Configuration saved!");

  p.note(
    `Provider: ${provider.name}\nModel: ${model}\nConfig: ${path.join(dataDir, "config.yaml")}${apiKey ? `\nAPI Key: ${path.join(dataDir, ".env")}` : ""}`,
    "Summary"
  );

  p.outro("Setup complete! Run: openacme start");
}
