import { ulid } from "ulid";
import type {
  Analyzer,
  AnalyzerConfig,
  AnalysisResult,
  BehavioralEvent,
  StorageAdapter,
} from "../types.js";

interface FlowData {
  steps: Map<number, { count: number; durations: number[]; actors: Set<string> }>;
  abandonments: number;
  completions: number;
  rageClicks: number;
  formRetries: number;
}

export class FrictionAnalyzer implements Analyzer {
  name = "friction";
  type = "friction" as const;

  async analyze(
    events: BehavioralEvent[],
    config: AnalyzerConfig,
    _storage: StorageAdapter,
  ): Promise<AnalysisResult> {
    const result: AnalysisResult = { findings: [], ambiguous: [] };
    const dropOffThreshold = config.thresholds["friction.dropOffPct"] ?? 0.4;
    const dwellMultiplier = config.thresholds["friction.dwellTimeMultiplier"] ?? 2.0;
    const rageClickThreshold = config.thresholds["friction.rageClickCount"] ?? 3;

    // Group events by flow
    const flows = new Map<string, FlowData>();

    for (const event of events) {
      const flowId = event.context?.flowId;
      if (!flowId && event.type !== "rage_click" && event.type !== "dwell" && event.type !== "form_retry") {
        continue;
      }

      if (flowId) {
        if (!flows.has(flowId)) {
          flows.set(flowId, {
            steps: new Map(),
            abandonments: 0,
            completions: 0,
            rageClicks: 0,
            formRetries: 0,
          });
        }
        const flow = flows.get(flowId)!;

        if (event.type === "abandonment") {
          flow.abandonments++;
        } else if (event.context?.flowStep !== undefined) {
          const step = event.context.flowStep;
          if (!flow.steps.has(step)) {
            flow.steps.set(step, { count: 0, durations: [], actors: new Set() });
          }
          const stepData = flow.steps.get(step)!;
          stepData.count++;
          stepData.actors.add(event.actor);
          if (event.context.duration) stepData.durations.push(event.context.duration);
        }
      }

      // Rage clicks on any feature
      if (event.type === "rage_click") {
        const clickCount = (event.metadata.clickCount as number) ?? event.context?.clickCount ?? 0;
        if (clickCount >= rageClickThreshold) {
          result.findings.push({
            id: ulid(),
            type: "friction",
            severity: "warning",
            confidence: 0.85,
            title: `Rage clicks detected on "${event.feature}"`,
            description: `Users are clicking "${event.feature}" ${clickCount} times rapidly, indicating the element is unresponsive or confusing.`,
            evidence: [
              { metric: "click_count", value: clickCount, context: "Rapid clicks on element" },
              { metric: "actor", value: event.actor, context: "Affected user" },
            ],
            suggestion: `Check if "${event.feature}" provides adequate feedback on interaction. Consider adding loading states or visual confirmation.`,
            analyzedAt: Date.now(),
            reported: false,
            sourceAnalyzer: this.name,
            escalatedToLLM: false,
          });
        }
      }

      // Form retries
      if (event.type === "form_retry") {
        const retryCount = (event.metadata.retryCount as number) ?? event.context?.retryCount ?? 0;
        if (retryCount >= 2) {
          result.findings.push({
            id: ulid(),
            type: "friction",
            severity: "warning",
            confidence: 0.8,
            title: `Form retry pattern on "${event.feature}"`,
            description: `Users are retrying form submission on "${event.feature}" ${retryCount} times. Validation may be unclear or overly strict.`,
            evidence: [
              { metric: "retry_count", value: retryCount, context: "Form resubmissions" },
            ],
            suggestion: `Improve validation feedback on "${event.feature}". Show inline errors and preserve valid input on retry.`,
            analyzedAt: Date.now(),
            reported: false,
            sourceAnalyzer: this.name,
            escalatedToLLM: false,
          });
        }
      }
    }

    // Analyze flow drop-off and dwell time
    for (const [flowId, flow] of flows) {
      const sortedSteps = Array.from(flow.steps.entries()).sort(([a], [b]) => a - b);
      if (sortedSteps.length < 2) continue;

      // Calculate median dwell time across all steps
      const allDurations = sortedSteps.flatMap(([, data]) => data.durations);
      const medianDwell = median(allDurations);

      for (let i = 1; i < sortedSteps.length; i++) {
        const [prevStep, prevData] = sortedSteps[i - 1];
        const [currStep, currData] = sortedSteps[i];

        // Drop-off rate
        const dropOff = prevData.count > 0 ? 1 - currData.count / prevData.count : 0;

        if (dropOff >= dropOffThreshold) {
          result.findings.push({
            id: ulid(),
            type: "friction",
            severity: dropOff >= 0.6 ? "critical" : "warning",
            confidence: 0.85,
            title: `${(dropOff * 100).toFixed(0)}% drop-off at step ${currStep} in flow "${flowId}"`,
            description: `${prevData.count} users reached step ${prevStep} but only ${currData.count} continued to step ${currStep}. ${(dropOff * 100).toFixed(0)}% of users dropped off here.`,
            evidence: [
              { metric: "prev_step_count", value: prevData.count, context: `Users at step ${prevStep}` },
              { metric: "curr_step_count", value: currData.count, context: `Users at step ${currStep}` },
              { metric: "drop_off_pct", value: dropOff, context: "Fraction of users lost" },
            ],
            suggestion: `Investigate step ${currStep} in flow "${flowId}". Simplify the step, reduce required fields, or add guidance.`,
            analyzedAt: Date.now(),
            reported: false,
            sourceAnalyzer: this.name,
            escalatedToLLM: false,
          });
        } else if (dropOff >= 0.2 && dropOff < dropOffThreshold) {
          // Moderate drop-off — ambiguous
          result.ambiguous.push({
            analyzerName: this.name,
            type: "friction",
            description: `Moderate ${(dropOff * 100).toFixed(0)}% drop-off at step ${currStep} in "${flowId}". Could be friction or natural filtering.`,
            evidence: [
              { metric: "drop_off_pct", value: dropOff, context: "Fraction lost between steps" },
            ],
            events: events
              .filter((e) => e.context?.flowId === flowId && e.context?.flowStep === currStep)
              .slice(0, 10),
          });
        }

        // Dwell time anomaly
        const stepMedian = median(currData.durations);
        if (medianDwell > 0 && stepMedian > medianDwell * dwellMultiplier) {
          result.findings.push({
            id: ulid(),
            type: "friction",
            severity: "info",
            confidence: 0.7,
            title: `Long dwell time at step ${currStep} in flow "${flowId}"`,
            description: `Users spend ${(stepMedian / 1000).toFixed(1)}s on step ${currStep}, which is ${(stepMedian / medianDwell).toFixed(1)}x the median across all steps (${(medianDwell / 1000).toFixed(1)}s). Users may be confused.`,
            evidence: [
              { metric: "step_median_dwell_ms", value: stepMedian, context: "Median time on this step" },
              { metric: "overall_median_dwell_ms", value: medianDwell, context: "Median across all steps" },
              { metric: "dwell_multiplier", value: stepMedian / medianDwell, context: "How many times longer" },
            ],
            suggestion: `Simplify step ${currStep} or add help text. Users are spending significantly longer here.`,
            analyzedAt: Date.now(),
            reported: false,
            sourceAnalyzer: this.name,
            escalatedToLLM: false,
          });
        }
      }
    }

    // Detect dwell events on non-flow features (user sitting on a page)
    const dwellEvents = events.filter((e) => e.type === "dwell");
    const dwellByFeature = new Map<string, number[]>();
    for (const e of dwellEvents) {
      const dur = (e.metadata.durationMs as number) ?? e.context?.duration ?? 0;
      if (!dwellByFeature.has(e.feature)) dwellByFeature.set(e.feature, []);
      dwellByFeature.get(e.feature)!.push(dur);
    }

    for (const [feature, durations] of dwellByFeature) {
      const med = median(durations);
      // Flag pages where median dwell is over 2 minutes
      if (med > 120_000 && durations.length >= 3) {
        result.findings.push({
          id: ulid(),
          type: "friction",
          severity: "info",
          confidence: 0.65,
          title: `Users linger on "${feature}" for ${(med / 1000).toFixed(0)}s`,
          description: `${durations.length} dwell events on "${feature}" with a median of ${(med / 1000).toFixed(0)}s. Users may be confused or searching for something.`,
          evidence: [
            { metric: "median_dwell_ms", value: med, context: "Median dwell time" },
            { metric: "dwell_count", value: durations.length, context: "Number of dwell events" },
          ],
          suggestion: `Add guidance, tooltips, or restructure "${feature}" to help users find what they need faster.`,
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
