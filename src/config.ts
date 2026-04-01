import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { MetaHarnessConfig } from "./types.js";

const CONFIG_FILES = [".proprio.json", ".proprio.yaml", "proprio.config.json"];

const DEFAULTS: Required<MetaHarnessConfig> = {
  storage: { adapter: "sqlite", path: "./.proprio/events.db" },
  analyzers: {
    enabled: ["workaround", "dead_feature", "friction", "emerging_workflow", "threshold_mismatch"],
    window: "7d",
    thresholds: {},
    excludeFeatures: [],
  },
  llm: {
    provider: "none",
    model: "claude-sonnet-4-20250514",
    maxEscalationsPerRun: 10,
  },
  reporters: { enabled: ["console"] },
  schedule: { cron: "0 9 * * 1" },
  buffer: { maxSize: 100, flushIntervalMs: 5000 },
};

export function loadConfig(dir?: string): Required<MetaHarnessConfig> {
  const base = dir ?? process.cwd();

  for (const file of CONFIG_FILES) {
    const path = join(base, file);
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as MetaHarnessConfig;
      return mergeConfig(raw);
    }
  }

  return DEFAULTS;
}

export function mergeConfig(partial: MetaHarnessConfig): Required<MetaHarnessConfig> {
  return {
    storage: { ...DEFAULTS.storage, ...partial.storage },
    analyzers: { ...DEFAULTS.analyzers, ...partial.analyzers },
    llm: {
      ...DEFAULTS.llm,
      ...partial.llm,
      apiKey: partial.llm?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    },
    reporters: {
      ...DEFAULTS.reporters,
      ...partial.reporters,
      github: partial.reporters?.github
        ? {
            ...partial.reporters.github,
            token: partial.reporters.github.token ?? process.env.GITHUB_TOKEN,
          }
        : undefined,
    } as Required<MetaHarnessConfig>["reporters"],
    schedule: { ...DEFAULTS.schedule, ...partial.schedule },
    buffer: { ...DEFAULTS.buffer, ...partial.buffer },
  };
}

export function parseWindow(window: string): number {
  const match = window.match(/^(\d+)(ms|s|m|h|d|w)$/);
  if (!match) throw new Error(`Invalid window format: ${window}. Use e.g. "7d", "24h", "30m"`);

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };

  return value * multipliers[unit];
}
