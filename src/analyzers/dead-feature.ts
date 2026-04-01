import { ulid } from "ulid";
import type {
  Analyzer,
  AnalyzerConfig,
  AnalysisResult,
  BehavioralEvent,
  StorageAdapter,
} from "../types.js";

export class DeadFeatureAnalyzer implements Analyzer {
  name = "dead_feature";
  type = "dead_feature" as const;

  async analyze(
    events: BehavioralEvent[],
    config: AnalyzerConfig,
    storage: StorageAdapter,
  ): Promise<AnalysisResult> {
    const result: AnalysisResult = { findings: [], ambiguous: [] };
    const since = Date.now() - config.windowMs;
    const usageDropThreshold = config.thresholds["dead_feature.usageDropPct"] ?? 0.01;
    const minActors = config.thresholds["dead_feature.minActors"] ?? 5;

    // Get all features that have ever been tracked
    const allFeatures = await storage.getDistinctFeatures(0);
    const recentFeatures = new Set(events.map((e) => e.feature));

    for (const feature of allFeatures) {
      const totalCount = await storage.getEventCount(feature, 0);
      const recentCount = await storage.getEventCount(feature, since);
      const recentActors = await storage.getDistinctActors(feature, since);

      // Skip features with very little history
      if (totalCount < 10) continue;

      const usageRatio = totalCount > 0 ? recentCount / totalCount : 0;

      if (!recentFeatures.has(feature) || recentCount === 0) {
        // Zero usage in the window
        result.findings.push({
          id: ulid(),
          type: "dead_feature",
          severity: "warning",
          confidence: 0.9,
          title: `Dead feature: "${feature}" has zero usage`,
          description: `Feature "${feature}" had ${totalCount} total historical events but zero in the last analysis window. Consider removing it.`,
          evidence: [
            { metric: "total_events", value: totalCount, context: "All-time event count" },
            { metric: "recent_events", value: 0, context: "Events in analysis window" },
          ],
          suggestion: `Remove or deprecate "${feature}" — no users are interacting with it.`,
          analyzedAt: Date.now(),
          reported: false,
          sourceAnalyzer: this.name,
          escalatedToLLM: false,
        });
      } else if (usageRatio <= usageDropThreshold && recentActors < minActors) {
        // Near-zero usage — might be dead or might be niche
        if (recentActors <= 2) {
          result.ambiguous.push({
            analyzerName: this.name,
            type: "dead_feature",
            description: `Feature "${feature}" has very low usage (${recentCount} events from ${recentActors} actors) but is not completely dead. Could be niche-but-essential or dying.`,
            evidence: [
              { metric: "recent_events", value: recentCount, context: "Events in analysis window" },
              { metric: "recent_actors", value: recentActors, context: "Distinct users in window" },
              { metric: "usage_ratio", value: usageRatio, context: "Recent/total event ratio" },
            ],
            events: events.filter((e) => e.feature === feature).slice(0, 20),
          });
        } else {
          result.findings.push({
            id: ulid(),
            type: "dead_feature",
            severity: "info",
            confidence: 0.7,
            title: `Declining feature: "${feature}" usage dropped to ${(usageRatio * 100).toFixed(1)}%`,
            description: `Feature "${feature}" usage has dropped significantly. Only ${recentActors} users interacted with it recently.`,
            evidence: [
              { metric: "total_events", value: totalCount, context: "All-time event count" },
              { metric: "recent_events", value: recentCount, context: "Events in analysis window" },
              { metric: "usage_ratio", value: usageRatio, context: "Recent/total ratio" },
            ],
            suggestion: `Investigate whether "${feature}" is still needed or can be simplified.`,
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
}
