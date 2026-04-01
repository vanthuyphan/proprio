import { ulid } from "ulid";
import type {
  Analyzer,
  AnalyzerConfig,
  AnalysisResult,
  BehavioralEvent,
  StorageAdapter,
} from "../types.js";

export class EmergingWorkflowAnalyzer implements Analyzer {
  name = "emerging_workflow";
  type = "emerging_workflow" as const;

  async analyze(
    events: BehavioralEvent[],
    config: AnalyzerConfig,
    _storage: StorageAdapter,
  ): Promise<AnalysisResult> {
    const result: AnalysisResult = { findings: [], ambiguous: [] };
    const minActorPct = config.thresholds["emerging_workflow.minActorPct"] ?? 0.1;
    const minOccurrences = config.thresholds["emerging_workflow.minOccurrences"] ?? 5;
    const sequenceLength = config.thresholds["emerging_workflow.sequenceLength"] ?? 3;

    // Build per-actor action sequences from navigation and interaction events
    const actorSequences = new Map<string, string[]>();
    const sortedEvents = [...events]
      .filter((e) => e.type === "navigation" || e.type === "interaction" || e.type === "api_call")
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const event of sortedEvents) {
      if (!actorSequences.has(event.actor)) actorSequences.set(event.actor, []);
      actorSequences.get(event.actor)!.push(event.feature);
    }

    const totalActors = actorSequences.size;
    if (totalActors < 3) return result;

    // Extract all n-grams of the configured sequence length
    const sequenceCounts = new Map<string, { count: number; actors: Set<string> }>();

    for (const [actor, sequence] of actorSequences) {
      const len = sequenceLength;
      for (let i = 0; i <= sequence.length - len; i++) {
        const ngram = sequence.slice(i, i + len);

        // Skip sequences where all steps are the same feature
        if (new Set(ngram).size === 1) continue;

        const key = ngram.join(" → ");
        if (!sequenceCounts.has(key)) {
          sequenceCounts.set(key, { count: 0, actors: new Set() });
        }
        const entry = sequenceCounts.get(key)!;
        entry.count++;
        entry.actors.add(actor);
      }
    }

    // Find sequences that meet thresholds
    for (const [sequence, data] of sequenceCounts) {
      const actorPct = data.actors.size / totalActors;

      if (data.count >= minOccurrences && actorPct >= minActorPct) {
        result.findings.push({
          id: ulid(),
          type: "emerging_workflow",
          severity: actorPct >= 0.3 ? "warning" : "info",
          confidence: Math.min(0.5 + actorPct, 0.9),
          title: `Emerging workflow: ${sequence}`,
          description: `${data.actors.size} users (${(actorPct * 100).toFixed(0)}% of active users) repeatedly follow the sequence: ${sequence}. This ${sequenceLength}-step pattern occurred ${data.count} times. Consider creating a shortcut or combined view.`,
          evidence: [
            { metric: "occurrence_count", value: data.count, context: "Times this sequence occurred" },
            { metric: "actor_count", value: data.actors.size, context: "Distinct users" },
            { metric: "actor_pct", value: actorPct, context: "Percentage of all active users" },
          ],
          suggestion: `Create a shortcut or combined view for "${sequence}". Users are doing this manually and repeatedly.`,
          analyzedAt: Date.now(),
          reported: false,
          sourceAnalyzer: this.name,
          escalatedToLLM: false,
        });
      } else if (data.count >= 3 && actorPct >= 0.05 && actorPct < minActorPct) {
        // Emerging but not yet strong enough
        result.ambiguous.push({
          analyzerName: this.name,
          type: "emerging_workflow",
          description: `Potential workflow: ${sequence} seen ${data.count} times from ${data.actors.size} users. Pattern exists but below threshold.`,
          evidence: [
            { metric: "occurrence_count", value: data.count, context: "Occurrences" },
            { metric: "actor_pct", value: actorPct, context: "User percentage" },
          ],
          events: sortedEvents.filter((e) => data.actors.has(e.actor)).slice(0, 20),
        });
      }
    }

    return result;
  }
}
