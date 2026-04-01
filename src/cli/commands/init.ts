import { writeFileSync, existsSync } from "fs";

const DEFAULT_CONFIG = {
  storage: { adapter: "sqlite", path: "./.proprio/events.db" },
  analyzers: {
    enabled: ["workaround", "dead_feature", "friction", "emerging_workflow", "threshold_mismatch"],
    window: "7d",
  },
  llm: { provider: "none" },
  reporters: { enabled: ["console"] },
};

export async function initCommand(): Promise<void> {
  const configPath = ".proprio.json";

  if (existsSync(configPath)) {
    console.log(`Config already exists at ${configPath}`);
    return;
  }

  writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  console.log(`Created ${configPath}`);
  console.log("\nNext steps:");
  console.log("  1. Install the SDK: npm install proprio");
  console.log("  2. Add tracking to your app:");
  console.log('     import { MetaHarness } from "proprio";');
  console.log("     const harness = new MetaHarness();");
  console.log('     harness.trackUsage("feature.name", userId);');
  console.log("  3. Run analysis: npx proprio analyze");
}
