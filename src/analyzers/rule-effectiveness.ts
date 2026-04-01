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
 * Analyzes whether business rules are actually producing good outcomes.
 *
 * Detects:
 * - Rules with low success rates (rule_ineffective)
 * - Rules whose effectiveness has degraded over time (rule_drift)
 */
export class RuleEffectivenessAnalyzer implements Analyzer {
  name = "rule_effectiveness";
  type = "rule_ineffective" as const;

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
    const minDecisions = config.thresholds["rule.minDecisions"] ?? 20;
    const successThreshold = config.thresholds["rule.successThreshold"] ?? 0.5;
    const driftThreshold = config.thresholds["rule.driftThreshold"] ?? 0.15;

    const rules = await ds.getDistinctRules(since);

    for (const ruleName of rules) {
      const pairs = await ds.getDecisionsWithOutcomes(ruleName, since);
      const withOutcomes = pairs.filter((p) => p.outcome !== undefined);

      if (withOutcomes.length < minDecisions) continue;

      const ruleDef = this.rules.get(ruleName);
      const successOutcomes = ruleDef?.successOutcomes ?? [];
      const failureOutcomes = ruleDef?.failureOutcomes ?? [];

      // Calculate success rate
      const { successRate, failureRate, outcomes } = this.calculateRates(
        withOutcomes,
        successOutcomes,
        failureOutcomes,
      );

      // Rule ineffective: low success rate
      if (successRate < successThreshold && successOutcomes.length > 0) {
        result.findings.push({
          id: ulid(),
          type: "rule_ineffective",
          severity: successRate < 0.2 ? "critical" : "warning",
          confidence: Math.min(0.6 + (withOutcomes.length / 100) * 0.3, 0.95),
          title: `Rule "${ruleName}" has ${(successRate * 100).toFixed(0)}% success rate`,
          description: `Out of ${withOutcomes.length} decisions with outcomes, only ${(successRate * 100).toFixed(0)}% resulted in success (${successOutcomes.join(", ")}). ${(failureRate * 100).toFixed(0)}% resulted in failure (${failureOutcomes.join(", ")}). This rule may need to be reworked.`,
          evidence: [
            { metric: "total_decisions", value: withOutcomes.length, context: "Decisions with tracked outcomes" },
            { metric: "success_rate", value: successRate, context: "Fraction of successful outcomes" },
            { metric: "failure_rate", value: failureRate, context: "Fraction of failed outcomes" },
            { metric: "outcome_breakdown", value: JSON.stringify(outcomes), context: "Outcome distribution" },
          ],
          suggestion: `Review the logic behind "${ruleName}". A ${(successRate * 100).toFixed(0)}% success rate suggests the rule's criteria don't align with what actually drives good outcomes.`,
          analyzedAt: Date.now(),
          reported: false,
          sourceAnalyzer: this.name,
          escalatedToLLM: false,
        });
      }

      // Rule drift: compare first half vs second half of the window
      const sorted = withOutcomes.sort((a, b) => a.decision.timestamp - b.decision.timestamp);
      const midpoint = Math.floor(sorted.length / 2);
      const firstHalf = sorted.slice(0, midpoint);
      const secondHalf = sorted.slice(midpoint);

      if (firstHalf.length >= 10 && secondHalf.length >= 10) {
        const earlyRate = this.calculateRates(firstHalf, successOutcomes, failureOutcomes).successRate;
        const recentRate = this.calculateRates(secondHalf, successOutcomes, failureOutcomes).successRate;
        const drift = earlyRate - recentRate;

        if (drift >= driftThreshold) {
          result.findings.push({
            id: ulid(),
            type: "rule_drift",
            severity: drift >= 0.25 ? "critical" : "warning",
            confidence: 0.8,
            title: `Rule "${ruleName}" effectiveness dropped ${(drift * 100).toFixed(0)}% over the analysis window`,
            description: `"${ruleName}" had a ${(earlyRate * 100).toFixed(0)}% success rate in the first half of the window but dropped to ${(recentRate * 100).toFixed(0)}% recently. Something has changed — the market, user behavior, or data distribution — and the rule hasn't kept up.`,
            evidence: [
              { metric: "early_success_rate", value: earlyRate, context: "Success rate in first half" },
              { metric: "recent_success_rate", value: recentRate, context: "Success rate in second half" },
              { metric: "drift", value: drift, context: "Rate decline" },
            ],
            suggestion: `The assumptions behind "${ruleName}" may be outdated. Re-evaluate the rule's criteria against current data.`,
            analyzedAt: Date.now(),
            reported: false,
            sourceAnalyzer: this.name,
            escalatedToLLM: false,
          });
        }
      }

      // Per-output breakdown: which outputs succeed vs fail?
      const outputGroups = new Map<string, { success: number; failure: number; total: number }>();
      for (const pair of withOutcomes) {
        const output = pair.decision.output;
        if (!outputGroups.has(output)) outputGroups.set(output, { success: 0, failure: 0, total: 0 });
        const group = outputGroups.get(output)!;
        group.total++;
        if (successOutcomes.includes(pair.outcome!.result)) group.success++;
        if (failureOutcomes.includes(pair.outcome!.result)) group.failure++;
      }

      // Flag outputs with significantly different success rates
      const overallSuccessRate = successRate;
      for (const [output, group] of outputGroups) {
        if (group.total < 5) continue;
        const outputSuccessRate = group.success / group.total;
        const delta = outputSuccessRate - overallSuccessRate;

        if (delta <= -0.2 && group.total >= 10) {
          result.findings.push({
            id: ulid(),
            type: "rule_bias",
            severity: "warning",
            confidence: 0.75,
            title: `Output "${output}" from rule "${ruleName}" underperforms by ${(Math.abs(delta) * 100).toFixed(0)}%`,
            description: `When "${ruleName}" decides "${output}", the success rate is ${(outputSuccessRate * 100).toFixed(0)}% vs ${(overallSuccessRate * 100).toFixed(0)}% overall. This output path is producing worse outcomes.`,
            evidence: [
              { metric: "output", value: output, context: "Decision output" },
              { metric: "output_success_rate", value: outputSuccessRate, context: "Success rate for this output" },
              { metric: "overall_success_rate", value: overallSuccessRate, context: "Overall success rate" },
              { metric: "sample_size", value: group.total, context: "Decisions with this output" },
            ],
            suggestion: `Investigate why "${output}" outcomes are worse. The conditions leading to this decision may need adjustment.`,
            analyzedAt: Date.now(),
            reported: false,
            sourceAnalyzer: this.name,
            escalatedToLLM: false,
          });
        }
      }
    }

    return result;
  }

  private calculateRates(
    pairs: DecisionWithOutcome[],
    successOutcomes: string[],
    failureOutcomes: string[],
  ) {
    const outcomes: Record<string, number> = {};
    let successes = 0;
    let failures = 0;

    for (const pair of pairs) {
      if (!pair.outcome) continue;
      const r = pair.outcome.result;
      outcomes[r] = (outcomes[r] ?? 0) + 1;
      if (successOutcomes.includes(r)) successes++;
      if (failureOutcomes.includes(r)) failures++;
    }

    const total = pairs.filter((p) => p.outcome).length;
    return {
      successRate: total > 0 ? successes / total : 0,
      failureRate: total > 0 ? failures / total : 0,
      outcomes,
    };
  }
}
