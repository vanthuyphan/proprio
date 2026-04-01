import type {
  DecisionStorageAdapter,
  DecisionWithOutcome,
  RuleDefinition,
  RuleFunction,
  ReplayResult,
  OutputChange,
  ReplayedDecision,
  StorageAdapter,
} from "../types.js";

export interface ReplayOptions {
  storage: StorageAdapter & DecisionStorageAdapter;
  rule: string;
  ruleDef?: RuleDefinition;
  newLogic: RuleFunction;
  since?: number;         // Defaults to all-time
  maxSamples?: number;    // Max sample decisions to include in result (default 20)
}

export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const {
    storage,
    rule,
    ruleDef,
    newLogic,
    since = 0,
    maxSamples = 20,
  } = options;

  const pairs = await storage.getDecisionsWithOutcomes(rule, since);
  const withOutcomes = pairs.filter((p) => p.outcome !== undefined);

  const successOutcomes = ruleDef?.successOutcomes ?? [];
  const failureOutcomes = ruleDef?.failureOutcomes ?? [];

  // Replay each decision through the new logic
  const replayed: ReplayedDecision[] = [];
  let changed = 0;
  let unchanged = 0;

  // Track output transitions
  const transitionMap = new Map<string, {
    count: number;
    successes: number;
    failures: number;
  }>();

  // Track current performance
  let currentSuccesses = 0;
  let currentRevenue = 0;

  // Track per-output success rates (for predicting new outcomes)
  const outputSuccessRates = new Map<string, { successes: number; total: number; revenue: number }>();

  // First pass: build outcome stats per output
  for (const pair of withOutcomes) {
    const output = pair.decision.output;
    if (!outputSuccessRates.has(output)) {
      outputSuccessRates.set(output, { successes: 0, total: 0, revenue: 0 });
    }
    const stats = outputSuccessRates.get(output)!;
    stats.total++;

    if (successOutcomes.includes(pair.outcome!.result)) {
      stats.successes++;
      currentSuccesses++;
    }
    if (pair.outcome!.value) {
      stats.revenue += pair.outcome!.value;
      currentRevenue += pair.outcome!.value;
    }
  }

  // Second pass: replay decisions
  for (const pair of withOutcomes) {
    let newOutput: string;
    try {
      newOutput = newLogic(pair.decision.inputs);
    } catch {
      // If new logic throws for this input, keep original
      newOutput = pair.decision.output;
    }

    const isChanged = newOutput !== pair.decision.output;
    if (isChanged) {
      changed++;
    } else {
      unchanged++;
    }

    // Track transition
    const transitionKey = `${pair.decision.output} → ${newOutput}`;
    if (!transitionMap.has(transitionKey)) {
      transitionMap.set(transitionKey, { count: 0, successes: 0, failures: 0 });
    }
    const transition = transitionMap.get(transitionKey)!;
    transition.count++;
    if (successOutcomes.includes(pair.outcome!.result)) transition.successes++;
    if (failureOutcomes.includes(pair.outcome!.result)) transition.failures++;

    // Predict outcome for changed decisions based on the new output's historical success rate
    let predictedOutcome: string | undefined;
    if (isChanged) {
      const newOutputStats = outputSuccessRates.get(newOutput);
      if (newOutputStats && newOutputStats.total > 0) {
        const newSuccessRate = newOutputStats.successes / newOutputStats.total;
        predictedOutcome = newSuccessRate >= 0.5
          ? (successOutcomes[0] ?? "success")
          : (failureOutcomes[0] ?? "failure");
      }
    }

    if (replayed.length < maxSamples && isChanged) {
      replayed.push({
        decisionId: pair.decision.id,
        inputs: pair.decision.inputs,
        originalOutput: pair.decision.output,
        newOutput,
        actualOutcome: pair.outcome!.result,
        actualValue: pair.outcome!.value,
        predictedOutcome,
      });
    }
  }

  // Calculate predicted success rate
  let predictedSuccesses = 0;
  let predictedRevenue = 0;

  for (const pair of withOutcomes) {
    let newOutput: string;
    try {
      newOutput = newLogic(pair.decision.inputs);
    } catch {
      newOutput = pair.decision.output;
    }

    if (newOutput === pair.decision.output) {
      // Unchanged — keep actual outcome
      if (successOutcomes.includes(pair.outcome!.result)) predictedSuccesses++;
      predictedRevenue += pair.outcome!.value ?? 0;
    } else {
      // Changed — predict based on new output's historical rate
      const newOutputStats = outputSuccessRates.get(newOutput);
      if (newOutputStats && newOutputStats.total > 0) {
        const rate = newOutputStats.successes / newOutputStats.total;
        predictedSuccesses += rate;
        const avgRevenue = newOutputStats.revenue / newOutputStats.total;
        predictedRevenue += avgRevenue;
      }
    }
  }

  const total = withOutcomes.length;
  const currentSuccessRate = total > 0 ? currentSuccesses / total : 0;
  const predictedSuccessRate = total > 0 ? predictedSuccesses / total : 0;

  // Build output changes
  const outputChanges: OutputChange[] = [];
  for (const [key, data] of transitionMap) {
    const [from, to] = key.split(" → ");
    if (from === to) continue;

    const fromStats = outputSuccessRates.get(from!);
    const toStats = outputSuccessRates.get(to!);

    outputChanges.push({
      from: from!,
      to: to!,
      count: data.count,
      currentSuccessRate: fromStats && fromStats.total > 0
        ? fromStats.successes / fromStats.total : 0,
      predictedSuccessRate: toStats && toStats.total > 0
        ? toStats.successes / toStats.total : 0,
    });
  }

  // Identify risks
  const risks: string[] = [];

  if (changed / total > 0.5) {
    risks.push(`High impact: ${((changed / total) * 100).toFixed(0)}% of decisions would change. Consider a gradual rollout.`);
  }

  if (predictedSuccessRate < currentSuccessRate) {
    risks.push(`Predicted success rate (${(predictedSuccessRate * 100).toFixed(1)}%) is lower than current (${(currentSuccessRate * 100).toFixed(1)}%). This change may make things worse.`);
  }

  // Check if any output would receive a disproportionate load
  const newOutputCounts = new Map<string, number>();
  for (const pair of withOutcomes) {
    let newOutput: string;
    try { newOutput = newLogic(pair.decision.inputs); } catch { newOutput = pair.decision.output; }
    newOutputCounts.set(newOutput, (newOutputCounts.get(newOutput) ?? 0) + 1);
  }
  for (const [output, count] of newOutputCounts) {
    const pct = count / total;
    if (pct > 0.8) {
      risks.push(`Output "${output}" would handle ${(pct * 100).toFixed(0)}% of all decisions. Possible overload.`);
    }
  }

  // Check for outputs that have never been seen
  for (const [output] of newOutputCounts) {
    if (!outputSuccessRates.has(output)) {
      risks.push(`Output "${output}" has no historical data. Cannot predict outcomes — proceed with caution.`);
    }
  }

  return {
    rule,
    totalDecisions: pairs.length,
    decisionsWithOutcomes: total,
    changed,
    unchanged,
    currentSuccessRate,
    predictedSuccessRate,
    successDelta: predictedSuccessRate - currentSuccessRate,
    currentRevenue,
    predictedRevenue,
    revenueDelta: predictedRevenue - currentRevenue,
    outputChanges,
    risks,
    samples: replayed,
  };
}

/**
 * Format a replay result as a human-readable report.
 */
export function formatReplayReport(result: ReplayResult): string {
  const lines: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const money = (n: number) => n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`;

  lines.push(`\n=== Replay Report: "${result.rule}" ===\n`);
  lines.push(`Replayed ${result.decisionsWithOutcomes} decisions (${result.totalDecisions} total, ${result.totalDecisions - result.decisionsWithOutcomes} pending outcomes)\n`);

  lines.push(`  Changed:   ${result.changed} decisions would have a different output`);
  lines.push(`  Unchanged: ${result.unchanged}\n`);

  lines.push(`  Current success rate:   ${pct(result.currentSuccessRate)}`);
  lines.push(`  Predicted success rate: ${pct(result.predictedSuccessRate)} (${result.successDelta >= 0 ? "+" : ""}${pct(result.successDelta)})`);

  if (result.currentRevenue > 0 || result.predictedRevenue > 0) {
    lines.push(`\n  Current revenue:   $${result.currentRevenue.toFixed(0)}`);
    lines.push(`  Predicted revenue: $${result.predictedRevenue.toFixed(0)} (${money(result.revenueDelta)})`);
  }

  if (result.outputChanges.length > 0) {
    lines.push(`\n  Output changes:`);
    for (const change of result.outputChanges) {
      lines.push(`    ${change.from} → ${change.to}: ${change.count} decisions`);
      lines.push(`      Success rate: ${pct(change.currentSuccessRate)} → ${pct(change.predictedSuccessRate)}`);
    }
  }

  if (result.risks.length > 0) {
    lines.push(`\n  Risks:`);
    for (const risk of result.risks) {
      lines.push(`    ⚠ ${risk}`);
    }
  }

  if (result.samples.length > 0) {
    lines.push(`\n  Sample changed decisions:`);
    for (const sample of result.samples.slice(0, 5)) {
      const inputs = Object.entries(sample.inputs)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`    [${inputs}] ${sample.originalOutput} → ${sample.newOutput} (was: ${sample.actualOutcome})`);
    }
    if (result.samples.length > 5) {
      lines.push(`    ... and ${result.samples.length - 5} more`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
