import { Command } from "commander";
import { loadConfig } from "../config.js";
import { initCommand } from "./commands/init.js";
import { analyzeCommand } from "./commands/analyze.js";
import { eventsCommand } from "./commands/events.js";
import { findingsCommand } from "./commands/findings.js";

const program = new Command();

program
  .name("meta-harness")
  .description("Framework for building self-evolving software through behavioral analysis")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize meta-harness configuration")
  .action(initCommand);

program
  .command("analyze")
  .description("Run the analysis pipeline")
  .option("--type <type>", "Run only a specific analyzer type")
  .option("--window <duration>", "Override analysis time window (e.g. 7d, 24h)")
  .option("--dry-run", "Print findings without reporting", false)
  .action(async (opts) => {
    const config = loadConfig();
    if (opts.type) config.analyzers.enabled = [opts.type];
    if (opts.window) config.analyzers.window = opts.window;
    await analyzeCommand(config, opts.dryRun);
  });

program
  .command("events")
  .description("List stored behavioral events")
  .option("--feature <name>", "Filter by feature name")
  .option("--type <type>", "Filter by event type")
  .option("--since <duration>", "Time window (e.g. 7d, 24h)", "7d")
  .option("--limit <n>", "Max events to show", "50")
  .action(async (opts) => {
    const config = loadConfig();
    await eventsCommand(config, opts);
  });

program
  .command("findings")
  .description("List stored findings")
  .option("--type <type>", "Filter by finding type")
  .option("--severity <level>", "Filter by severity (info, warning, critical)")
  .option("--unreported", "Show only unreported findings", false)
  .option("--limit <n>", "Max findings to show", "50")
  .action(async (opts) => {
    const config = loadConfig();
    await findingsCommand(config, opts);
  });

export { program };
