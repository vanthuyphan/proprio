import { ulid } from "ulid";
import type {
  Analyzer,
  AnalyzerConfig,
  AnalysisResult,
  BehavioralEvent,
  StorageAdapter,
} from "../types.js";

// Patterns that suggest structured data in free-text fields
const STRUCTURED_PATTERNS = [
  /^[A-Z_]+:\s*.+/,                    // STATUS: approved
  /^\w+\s*[:=]\s*\w+/,                 // key=value or key: value
  /^\d{4}-\d{2}-\d{2}/,               // Date format
  /^#\w+/,                             // Hashtag/tag
  /^\[.+\]\s*.+/,                      // [TAG] content
  /^(TODO|FIXME|NOTE|HACK|PENDING)/i,  // Task markers
  /\|\s*\w+\s*\|/,                     // Pipe-delimited data
  /;\s*\w+\s*[:=]/,                    // Multiple key-value pairs
];

export class WorkaroundAnalyzer implements Analyzer {
  name = "workaround";
  type = "workaround" as const;

  async analyze(
    events: BehavioralEvent[],
    config: AnalyzerConfig,
    _storage: StorageAdapter,
  ): Promise<AnalysisResult> {
    const result: AnalysisResult = { findings: [], ambiguous: [] };
    const structuredThreshold = config.thresholds["workaround.structuredContentPct"] ?? 0.15;

    // Focus on field_mutation events
    const fieldMutations = events.filter((e) => e.type === "field_mutation");

    // Group by feature + field
    const fieldGroups = new Map<string, { total: number; structured: number; samples: string[] }>();

    for (const event of fieldMutations) {
      const field = event.metadata.field as string;
      const value = event.metadata.value;
      if (!field || value === undefined || value === null) continue;

      const key = `${event.feature}::${field}`;
      if (!fieldGroups.has(key)) {
        fieldGroups.set(key, { total: 0, structured: 0, samples: [] });
      }

      const group = fieldGroups.get(key)!;
      group.total++;

      const strValue = String(value);
      if (STRUCTURED_PATTERNS.some((p) => p.test(strValue))) {
        group.structured++;
        if (group.samples.length < 5) group.samples.push(strValue);
      }
    }

    for (const [key, group] of fieldGroups) {
      if (group.total < 5) continue;

      const structuredPct = group.structured / group.total;
      const [feature, field] = key.split("::");

      if (structuredPct >= structuredThreshold) {
        result.findings.push({
          id: ulid(),
          type: "workaround",
          severity: structuredPct >= 0.5 ? "critical" : "warning",
          confidence: Math.min(0.6 + structuredPct, 0.95),
          title: `Field "${field}" in "${feature}" is used for structured data`,
          description: `${(structuredPct * 100).toFixed(0)}% of values in "${field}" contain structured patterns (key:value, tags, dates). Users are likely working around a missing feature by encoding data in a free-text field.`,
          evidence: [
            { metric: "structured_pct", value: structuredPct, context: "Fraction of structured values" },
            { metric: "total_mutations", value: group.total, context: "Total field changes" },
            { metric: "sample_values", value: group.samples.join(" | "), context: "Example structured values" },
          ],
          suggestion: `Consider adding a dedicated field or feature for what users are tracking in "${field}". Samples: ${group.samples.slice(0, 3).join(", ")}`,
          analyzedAt: Date.now(),
          reported: false,
          sourceAnalyzer: this.name,
          escalatedToLLM: false,
        });
      } else if (structuredPct >= 0.05 && structuredPct < structuredThreshold) {
        // Low but non-zero structured content — ambiguous
        result.ambiguous.push({
          analyzerName: this.name,
          type: "workaround",
          description: `Field "${field}" in "${feature}" has ${(structuredPct * 100).toFixed(0)}% structured content. Below threshold but worth investigating.`,
          evidence: [
            { metric: "structured_pct", value: structuredPct, context: "Fraction of structured values" },
            { metric: "sample_values", value: group.samples.join(" | "), context: "Samples" },
          ],
          events: fieldMutations
            .filter((e) => e.metadata.field === field && `${e.feature}::${field}` === key)
            .slice(0, 10),
        });
      }
    }

    return result;
  }
}
