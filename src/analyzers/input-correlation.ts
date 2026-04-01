import { ulid } from "ulid";
import type {
  Analyzer,
  AnalyzerConfig,
  AnalysisResult,
  BehavioralEvent,
  StorageAdapter,
  DecisionStorageAdapter,
  DecisionWithOutcome,
  RuleDefinition,
} from "../types.js";

/**
 * Analyzes which inputs actually correlate with successful outcomes.
 *
 * Detects:
 * - Inputs the rule uses that have no correlation with success
 * - Inputs the rule ignores that strongly correlate with success
 * - Suggests weight adjustments based on actual outcome data
 */
export class InputCorrelationAnalyzer implements Analyzer {
  name = "input_correlation";
  type = "input_correlation" as const;

  private rules: Map<string, RuleDefinition>;

  constructor(rules?: Map<string, RuleDefinition>) {
    this.rules = rules ?? new Map();
  }

  async analyze(
    _events: BehavioralEvent[],
    config: AnalyzerConfig,
    storage: StorageAdapter,
  ): Promise<AnalysisResult> {
    const result: AnalysisResult = { findings: [], ambiguous: [] };
    const ds = storage as StorageAdapter & DecisionStorageAdapter;
    if (!ds.getDecisionsWithOutcomes || !ds.getDistinctRules) return result;

    const since = Date.now() - config.windowMs;
    const minSample = config.thresholds["correlation.minSample"] ?? 30;
    const strongCorrelation = config.thresholds["correlation.strong"] ?? 0.4;
    const weakCorrelation = config.thresholds["correlation.weak"] ?? 0.1;

    const rules = await ds.getDistinctRules(since);

    for (const ruleName of rules) {
      const pairs = await ds.getDecisionsWithOutcomes(ruleName, since);
      const withOutcomes = pairs.filter((p) => p.outcome !== undefined);

      if (withOutcomes.length < minSample) continue;

      const ruleDef = this.rules.get(ruleName);
      const successOutcomes = ruleDef?.successOutcomes ?? [];
      if (successOutcomes.length === 0) continue;

      // Collect all numeric input fields
      const inputFields = this.extractNumericFields(withOutcomes);

      // Calculate correlation of each input with success
      const correlations: Array<{
        field: string;
        correlation: number;
        isRegisteredInput: boolean;
      }> = [];

      const successBinary = withOutcomes.map((p) =>
        successOutcomes.includes(p.outcome!.result) ? 1 : 0,
      );

      for (const [field, values] of inputFields) {
        if (values.length !== withOutcomes.length) continue;

        const corr = pearsonCorrelation(values, successBinary);
        if (isNaN(corr)) continue;

        const isRegisteredInput = ruleDef?.inputs.includes(field) ?? true;
        correlations.push({ field, correlation: corr, isRegisteredInput });
      }

      // Find inputs the rule uses but that don't correlate with success
      const uselessInputs = correlations.filter(
        (c) => c.isRegisteredInput && Math.abs(c.correlation) < weakCorrelation,
      );

      if (uselessInputs.length > 0) {
        result.findings.push({
          id: ulid(),
          type: "input_correlation",
          severity: "warning",
          confidence: 0.7,
          title: `Rule "${ruleName}" uses inputs with near-zero correlation to success`,
          description: `The following inputs used by "${ruleName}" have almost no correlation with successful outcomes: ${uselessInputs.map((u) => `${u.field} (r=${u.correlation.toFixed(3)})`).join(", ")}. These inputs add complexity without predictive value.`,
          evidence: uselessInputs.map((u) => ({
            metric: `correlation_${u.field}`,
            value: u.correlation,
            context: `Pearson r for "${u.field}" vs success`,
          })),
          suggestion: `Consider removing or reducing the weight of: ${uselessInputs.map((u) => u.field).join(", ")}. They don't predict success.`,
          analyzedAt: Date.now(),
          reported: false,
          sourceAnalyzer: this.name,
          escalatedToLLM: false,
        });
      }

      // Find inputs the rule ignores but that strongly correlate with success
      const hiddenPredictors = correlations.filter(
        (c) => !c.isRegisteredInput && Math.abs(c.correlation) >= strongCorrelation,
      );

      if (hiddenPredictors.length > 0) {
        result.findings.push({
          id: ulid(),
          type: "input_correlation",
          severity: "critical",
          confidence: 0.8,
          title: `Rule "${ruleName}" ignores inputs that strongly predict success`,
          description: `The following fields are NOT used by "${ruleName}" but have strong correlation with successful outcomes: ${hiddenPredictors.map((h) => `${h.field} (r=${h.correlation.toFixed(3)})`).join(", ")}. Incorporating these could significantly improve the rule.`,
          evidence: hiddenPredictors.map((h) => ({
            metric: `correlation_${h.field}`,
            value: h.correlation,
            context: `Pearson r for "${h.field}" vs success (NOT currently used by rule)`,
          })),
          suggestion: `Add these inputs to "${ruleName}": ${hiddenPredictors.map((h) => h.field).join(", ")}. They have strong predictive power that the rule is currently ignoring.`,
          analyzedAt: Date.now(),
          reported: false,
          sourceAnalyzer: this.name,
          escalatedToLLM: false,
        });
      }

      // Show the full correlation ranking for context
      const sorted = correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
      if (sorted.length >= 3) {
        const topUsed = sorted.filter((c) => c.isRegisteredInput).slice(0, 3);
        const topIgnored = sorted.filter((c) => !c.isRegisteredInput).slice(0, 3);

        if (topIgnored.length > 0 && topUsed.length > 0) {
          const bestIgnored = topIgnored[0];
          const worstUsed = topUsed[topUsed.length - 1];

          if (
            bestIgnored &&
            worstUsed &&
            Math.abs(bestIgnored.correlation) > Math.abs(worstUsed.correlation) * 2
          ) {
            result.ambiguous.push({
              analyzerName: this.name,
              type: "input_correlation",
              description: `In rule "${ruleName}", the best unused input "${bestIgnored.field}" (r=${bestIgnored.correlation.toFixed(3)}) correlates ${(Math.abs(bestIgnored.correlation) / Math.abs(worstUsed.correlation)).toFixed(1)}x more strongly than the weakest used input "${worstUsed.field}" (r=${worstUsed.correlation.toFixed(3)}). Consider swapping them.`,
              evidence: [
                { metric: `best_unused`, value: `${bestIgnored.field} (r=${bestIgnored.correlation.toFixed(3)})`, context: "Strongest unused predictor" },
                { metric: `weakest_used`, value: `${worstUsed.field} (r=${worstUsed.correlation.toFixed(3)})`, context: "Weakest used predictor" },
              ],
              events: [],
            });
          }
        }
      }
    }

    return result;
  }

  private extractNumericFields(
    pairs: DecisionWithOutcome[],
  ): Map<string, number[]> {
    const fields = new Map<string, number[]>();

    // Collect all field names from all decisions
    const allFields = new Set<string>();
    for (const pair of pairs) {
      for (const key of Object.keys(pair.decision.inputs)) {
        allFields.add(key);
      }
      // Also check metadata for hidden inputs
      if (pair.decision.metadata) {
        for (const key of Object.keys(pair.decision.metadata)) {
          allFields.add(key);
        }
      }
    }

    for (const field of allFields) {
      const values: number[] = [];
      let allNumeric = true;

      for (const pair of pairs) {
        const val = pair.decision.inputs[field] ?? pair.decision.metadata?.[field];
        if (typeof val === "number") {
          values.push(val);
        } else if (typeof val === "boolean") {
          values.push(val ? 1 : 0);
        } else {
          allNumeric = false;
          break;
        }
      }

      if (allNumeric && values.length === pairs.length) {
        fields.set(field, values);
      }
    }

    return fields;
  }
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return NaN;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return numerator / denominator;
}
