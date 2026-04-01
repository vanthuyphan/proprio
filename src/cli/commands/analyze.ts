import type { MetaHarnessConfig } from "../../types.js";
import { SqliteStorage } from "../../storage/sqlite.js";
import { runPipeline } from "../../analyzers/pipeline.js";
import { ConsoleReporter } from "../../reporters/console.js";
import { GitHubReporter } from "../../reporters/github.js";
import { ClaudeLLMProvider } from "../../llm/claude.js";
import type { Reporter, LLMProvider } from "../../types.js";

export async function analyzeCommand(
  config: Required<MetaHarnessConfig>,
  dryRun: boolean,
): Promise<void> {
  const storage = new SqliteStorage(config.storage.path!);

  // Set up reporters
  const reporters: Reporter[] = [];
  if (config.reporters.enabled?.includes("console")) {
    reporters.push(new ConsoleReporter());
  }
  if (config.reporters.enabled?.includes("github") && config.reporters.github) {
    const token = config.reporters.github.token ?? process.env.GITHUB_TOKEN;
    if (token) {
      reporters.push(
        new GitHubReporter({
          token,
          owner: config.reporters.github.owner,
          repo: config.reporters.github.repo,
          labels: config.reporters.github.labels,
        }),
      );
    } else {
      console.warn("[meta-harness] GitHub reporter enabled but no token found. Set GITHUB_TOKEN env var.");
    }
  }

  // Set up LLM
  let llm: LLMProvider | undefined;
  if (config.llm.provider === "claude") {
    const apiKey = config.llm.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      llm = new ClaudeLLMProvider(apiKey, config.llm.model);
    } else {
      console.warn("[meta-harness] Claude LLM enabled but no API key found. Set ANTHROPIC_API_KEY env var.");
    }
  }

  console.log(`\nRunning meta-harness analysis...`);
  console.log(`  Analyzers: ${config.analyzers.enabled!.join(", ")}`);
  console.log(`  Window: ${config.analyzers.window}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log("");

  const result = await runPipeline({
    storage,
    config,
    llm,
    reporters: dryRun ? [new ConsoleReporter()] : reporters,
    dryRun,
  });

  console.log(`\n--- Summary ---`);
  console.log(`  Findings: ${result.findings.length}`);
  console.log(`  Ambiguous cases: ${result.ambiguousCases}`);
  console.log(`  Escalated to LLM: ${result.escalated}`);
  console.log(`  Reported: ${result.reported}`);

  await storage.close();
}
