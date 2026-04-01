import type {
  Analyzer,
  AnalyzerConfig,
  Finding,
  AmbiguousCase,
  StorageAdapter,
  LLMProvider,
  Reporter,
  MetaHarnessConfig,
} from "../types.js";
import { parseWindow } from "../config.js";
import { DeadFeatureAnalyzer } from "./dead-feature.js";
import { FrictionAnalyzer } from "./friction.js";
import { WorkaroundAnalyzer } from "./workaround.js";
import { EmergingWorkflowAnalyzer } from "./emerging-workflow.js";
import { ThresholdMismatchAnalyzer } from "./threshold-mismatch.js";
import { RuleEffectivenessAnalyzer } from "./rule-effectiveness.js";
import { InputCorrelationAnalyzer } from "./input-correlation.js";
import { ErrorClusterAnalyzer } from "./error-cluster.js";
import { FixGenerator } from "../llm/fix-generator.js";
import type { RuleDefinition, FixProposal } from "../types.js";

function buildAnalyzers(rules?: Map<string, RuleDefinition>): Record<string, () => Analyzer> {
  return {
    dead_feature: () => new DeadFeatureAnalyzer(),
    friction: () => new FrictionAnalyzer(),
    workaround: () => new WorkaroundAnalyzer(),
    emerging_workflow: () => new EmergingWorkflowAnalyzer(),
    threshold_mismatch: () => new ThresholdMismatchAnalyzer(),
    rule_ineffective: () => new RuleEffectivenessAnalyzer(rules),
    input_correlation: () => new InputCorrelationAnalyzer(rules),
    error_cluster: () => new ErrorClusterAnalyzer(),
  };
}

export interface PipelineOptions {
  storage: StorageAdapter;
  config: Required<MetaHarnessConfig>;
  llm?: LLMProvider;
  reporters?: Reporter[];
  dryRun?: boolean;
  rules?: Map<string, RuleDefinition>;
  generateFixes?: boolean;
}

export interface PipelineResult {
  findings: Finding[];
  ambiguousCases: number;
  escalated: number;
  reported: number;
  fixes: number;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { storage, config, llm, reporters = [], dryRun = false, rules } = options;

  const windowMs = parseWindow(config.analyzers.window!);
  const since = Date.now() - windowMs;

  const analyzerConfig: AnalyzerConfig = {
    windowMs,
    thresholds: config.analyzers.thresholds ?? {},
    excludeFeatures: config.analyzers.excludeFeatures ?? [],
  };

  // Build analyzer list
  const analyzerMap = buildAnalyzers(rules);
  const analyzers: Analyzer[] = [];
  for (const name of config.analyzers.enabled!) {
    const factory = analyzerMap[name];
    if (factory) analyzers.push(factory());
  }

  // Run all analyzers
  const allFindings: Finding[] = [];
  const allAmbiguous: AmbiguousCase[] = [];

  const events = await storage.queryEvents({ since });

  for (const analyzer of analyzers) {
    // Filter out excluded features
    const filtered = events.filter((e) => {
      return !analyzerConfig.excludeFeatures.some((pattern) => {
        if (pattern.includes("*")) {
          const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
          return regex.test(e.feature);
        }
        return e.feature === pattern;
      });
    });

    const result = await analyzer.analyze(filtered, analyzerConfig, storage);
    allFindings.push(...result.findings);
    allAmbiguous.push(...result.ambiguous);
  }

  // Deduplicate against existing findings
  const existingFindings = await storage.queryFindings({ since, reported: true });
  const deduped = allFindings.filter((f) => {
    return !existingFindings.some(
      (existing) =>
        existing.type === f.type &&
        existing.title === f.title &&
        existing.sourceAnalyzer === f.sourceAnalyzer,
    );
  });

  // LLM escalation for ambiguous cases
  let escalatedCount = 0;
  if (llm && allAmbiguous.length > 0) {
    const maxEscalations = config.llm.maxEscalationsPerRun ?? 10;
    const toEscalate = allAmbiguous.slice(0, maxEscalations);
    escalatedCount = toEscalate.length;

    const llmFindings = await llm.analyze(toEscalate);
    deduped.push(...llmFindings);
  }

  // Auto-evolve mode: generate fix proposals for actionable findings
  let fixCount = 0;
  if (options.generateFixes && config.llm.provider === "claude") {
    const apiKey = config.llm.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      const fixGenerator = new FixGenerator({ apiKey, model: config.llm.model });
      const fixableTypes = ["error_cluster", "error_spike", "recurring_error"];
      const fixable = deduped.filter(
        (f) => fixableTypes.includes(f.type) && f.severity !== "info",
      );

      if (fixable.length > 0) {
        const fixes = await fixGenerator.generateFixes(fixable);
        fixCount = fixes.size;
      }
    }
  }

  // Store findings
  for (const finding of deduped) {
    await storage.insertFinding(finding);
  }

  // Report
  let reportedCount = 0;
  if (!dryRun) {
    for (const finding of deduped) {
      for (const reporter of reporters) {
        const result = await reporter.report(finding);
        if (result.success) {
          reportedCount++;
          await storage.updateFinding(finding.id, {
            reported: true,
            reportRef: result.ref,
          });
        }
      }
    }
  }

  return {
    findings: deduped,
    fixes: fixCount,
    ambiguousCases: allAmbiguous.length,
    escalated: escalatedCount,
    reported: reportedCount,
  };
}
