import { ulid } from "ulid";
import type {
  Analyzer,
  AnalyzerConfig,
  AnalysisResult,
  BehavioralEvent,
  StorageAdapter,
  ErrorStorageAdapter,
} from "../types.js";

/**
 * Self-healing analyzer: clusters errors by signature,
 * detects spikes, and flags recurring errors.
 */
export class ErrorClusterAnalyzer implements Analyzer {
  name = "error_cluster";
  type = "error_cluster" as const;

  async analyze(
    _events: BehavioralEvent[],
    config: AnalyzerConfig,
    storage: StorageAdapter,
  ): Promise<AnalysisResult> {
    const result: AnalysisResult = { findings: [], ambiguous: [] };
    const es = storage as StorageAdapter & ErrorStorageAdapter;
    if (!es.getErrorClusters || !es.getErrorCountByWindow) return result;

    const since = Date.now() - config.windowMs;
    const minClusterSize = config.thresholds["error.minClusterSize"] ?? 5;
    const spikeMultiplier = config.thresholds["error.spikeMultiplier"] ?? 3;
    const spikeBuckets = 6; // divide window into 6 buckets

    const clusters = await es.getErrorClusters(since);

    for (const cluster of clusters) {
      if (cluster.count < minClusterSize) continue;

      // ─── Error cluster finding ───
      const sample = cluster.samples[0];
      result.findings.push({
        id: ulid(),
        type: "error_cluster",
        severity: cluster.count >= 50 ? "critical" : cluster.count >= 20 ? "warning" : "info",
        confidence: 0.9,
        title: `${cluster.count}x "${sample?.kind}: ${sample?.message.slice(0, 80)}"`,
        description: `Error occurred ${cluster.count} times across ${cluster.actors.size} users. Routes affected: ${cluster.routes.join(", ") || "unknown"}. First seen: ${new Date(cluster.firstSeen).toISOString()}, last seen: ${new Date(cluster.lastSeen).toISOString()}.`,
        evidence: [
          { metric: "error_count", value: cluster.count, context: "Total occurrences in window" },
          { metric: "affected_users", value: cluster.actors.size, context: "Distinct users" },
          { metric: "routes", value: cluster.routes.join(", "), context: "Affected routes" },
          { metric: "signature", value: cluster.signature, context: "Error fingerprint" },
          { metric: "stack_trace", value: sample?.stack.split("\n").slice(0, 5).join("\n") ?? "", context: "Stack trace (first 5 frames)" },
          ...(sample?.codeContext ? [{
            metric: "source_location",
            value: `${sample.codeContext.file}:${sample.codeContext.line}${sample.codeContext.functionName ? ` in ${sample.codeContext.functionName}` : ""}`,
            context: "Source code location",
          }] : []),
        ],
        suggestion: sample?.codeContext
          ? `Fix the error in ${sample.codeContext.file}:${sample.codeContext.line}${sample.codeContext.functionName ? ` (${sample.codeContext.functionName})` : ""}. It's hitting ${cluster.actors.size} users.`
          : `Investigate and fix: "${sample?.message}". It's hitting ${cluster.actors.size} users across ${cluster.routes.length} routes.`,
        analyzedAt: Date.now(),
        reported: false,
        sourceAnalyzer: this.name,
        escalatedToLLM: false,
      });

      // ─── Spike detection ───
      const bucketCounts = await es.getErrorCountByWindow(
        cluster.signature,
        config.windowMs,
        spikeBuckets,
      );

      // Compare latest bucket to average of earlier buckets
      const latest = bucketCounts[bucketCounts.length - 1] ?? 0;
      const earlier = bucketCounts.slice(0, -1);
      const avgEarlier = earlier.length > 0
        ? earlier.reduce((a, b) => a + b, 0) / earlier.length
        : 0;

      if (latest > 0 && avgEarlier > 0 && latest >= avgEarlier * spikeMultiplier) {
        result.findings.push({
          id: ulid(),
          type: "error_spike",
          severity: "critical",
          confidence: 0.85,
          title: `Error spike: "${sample?.message.slice(0, 60)}" — ${latest} recent vs avg ${avgEarlier.toFixed(1)}`,
          description: `Error "${cluster.signature}" spiked ${(latest / avgEarlier).toFixed(1)}x in the most recent time bucket. This may indicate a regression from a recent deploy.`,
          evidence: [
            { metric: "recent_count", value: latest, context: "Errors in latest bucket" },
            { metric: "avg_earlier", value: avgEarlier, context: "Average in earlier buckets" },
            { metric: "spike_ratio", value: latest / avgEarlier, context: "Spike multiplier" },
            { metric: "bucket_distribution", value: bucketCounts.join(", "), context: "Error counts per time bucket (oldest → newest)" },
          ],
          suggestion: `This error is spiking. Check recent deploys. Consider reverting if this correlates with a recent change.`,
          analyzedAt: Date.now(),
          reported: false,
          sourceAnalyzer: this.name,
          escalatedToLLM: false,
        });
      }

      // ─── Recurring error detection ───
      // If error spans most of the window with consistent presence, it's recurring (not a spike — a chronic issue)
      const bucketsWithErrors = bucketCounts.filter((c) => c > 0).length;
      if (bucketsWithErrors >= spikeBuckets * 0.8 && cluster.count >= 10) {
        result.findings.push({
          id: ulid(),
          type: "recurring_error",
          severity: "warning",
          confidence: 0.8,
          title: `Recurring error: "${sample?.message.slice(0, 60)}" — present in ${bucketsWithErrors}/${spikeBuckets} time periods`,
          description: `Error "${cluster.signature}" has been occurring consistently throughout the analysis window. This is not a spike — it's a chronic issue that hasn't been fixed. ${cluster.count} total occurrences.`,
          evidence: [
            { metric: "presence_ratio", value: bucketsWithErrors / spikeBuckets, context: "Fraction of time periods with this error" },
            { metric: "total_count", value: cluster.count, context: "Total occurrences" },
          ],
          suggestion: `This error has been recurring for the entire analysis window. It needs a proper fix, not a retry or workaround.`,
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
