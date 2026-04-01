import { ulid } from "ulid";
import type {
  Analyzer,
  AnalyzerConfig,
  AnalysisResult,
  BehavioralEvent,
  StorageAdapter,
} from "../types.js";

export class ThresholdMismatchAnalyzer implements Analyzer {
  name = "threshold_mismatch";
  type = "threshold_mismatch" as const;

  async analyze(
    events: BehavioralEvent[],
    config: AnalyzerConfig,
    _storage: StorageAdapter,
  ): Promise<AnalysisResult> {
    const result: AnalysisResult = { findings: [], ambiguous: [] };
    const clusterPct = config.thresholds["threshold_mismatch.clusterPct"] ?? 0.3;
    const boundaryRange = config.thresholds["threshold_mismatch.boundaryRange"] ?? 0.1;

    // Look for business rules defined in thresholds config
    // Format: "rule.<name>.threshold" = value, "rule.<name>.field" = metadata key
    const rules = extractRules(config.thresholds);

    for (const rule of rules) {
      // Find events that have the relevant metadata field
      const relevantEvents = events.filter(
        (e) => e.feature === rule.feature && e.metadata[rule.field] !== undefined,
      );

      if (relevantEvents.length < 10) continue;

      const values = relevantEvents
        .map((e) => Number(e.metadata[rule.field]))
        .filter((v) => !isNaN(v));

      if (values.length < 10) continue;

      // Count values near the threshold boundary
      const lowerBound = rule.threshold * (1 - boundaryRange);
      const upperBound = rule.threshold * (1 + boundaryRange);
      const nearBoundary = values.filter((v) => v >= lowerBound && v <= upperBound);
      const nearPct = nearBoundary.length / values.length;

      // Calculate where the actual "natural" threshold might be
      const sortedValues = [...values].sort((a, b) => a - b);
      const p25 = sortedValues[Math.floor(sortedValues.length * 0.25)];
      const p50 = sortedValues[Math.floor(sortedValues.length * 0.5)];
      const p75 = sortedValues[Math.floor(sortedValues.length * 0.75)];

      if (nearPct >= clusterPct) {
        result.findings.push({
          id: ulid(),
          type: "threshold_mismatch",
          severity: nearPct >= 0.5 ? "warning" : "info",
          confidence: Math.min(0.5 + nearPct, 0.9),
          title: `Threshold mismatch: "${rule.name}" set at ${rule.threshold} but ${(nearPct * 100).toFixed(0)}% of values cluster near it`,
          description: `The business rule "${rule.name}" has a threshold of ${rule.threshold}, but ${(nearPct * 100).toFixed(0)}% of values for "${rule.field}" fall within ±${(boundaryRange * 100).toFixed(0)}% of this boundary. The distribution suggests the threshold may not match real usage patterns. Median value: ${p50}, 25th percentile: ${p25}, 75th percentile: ${p75}.`,
          evidence: [
            { metric: "threshold", value: rule.threshold, context: "Current threshold" },
            { metric: "near_boundary_pct", value: nearPct, context: "Values clustering near threshold" },
            { metric: "p25", value: p25, context: "25th percentile" },
            { metric: "median", value: p50, context: "Median value" },
            { metric: "p75", value: p75, context: "75th percentile" },
          ],
          suggestion: `Consider adjusting the "${rule.name}" threshold. Current: ${rule.threshold}. Median actual value: ${p50}. Many values cluster right around the boundary, suggesting it's either too high or too low.`,
          analyzedAt: Date.now(),
          reported: false,
          sourceAnalyzer: this.name,
          escalatedToLLM: false,
        });
      }
    }

    return result;
  }
}

interface BusinessRule {
  name: string;
  feature: string;
  field: string;
  threshold: number;
}

function extractRules(thresholds: Record<string, number>): BusinessRule[] {
  const rules: BusinessRule[] = [];
  const ruleMap = new Map<string, Partial<BusinessRule>>();

  for (const [key, value] of Object.entries(thresholds)) {
    const match = key.match(/^rule\.(.+)\.(threshold|field|feature)$/);
    if (!match) continue;

    const [, name, prop] = match;
    if (!ruleMap.has(name)) ruleMap.set(name, { name });
    const rule = ruleMap.get(name)!;

    if (prop === "threshold") rule.threshold = value;
    if (prop === "field") rule.field = String(value);
    if (prop === "feature") rule.feature = String(value);
  }

  for (const rule of ruleMap.values()) {
    if (rule.name && rule.feature && rule.field && rule.threshold !== undefined) {
      rules.push(rule as BusinessRule);
    }
  }

  return rules;
}
