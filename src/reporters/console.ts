import type { Reporter, Finding, ReportResult } from "../types.js";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "\x1b[31m",  // red
  warning: "\x1b[33m",   // yellow
  info: "\x1b[36m",      // cyan
};
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

export class ConsoleReporter implements Reporter {
  name = "console";

  async report(finding: Finding): Promise<ReportResult> {
    const color = SEVERITY_COLORS[finding.severity] ?? "";
    const badge = `${color}[${finding.severity.toUpperCase()}]${RESET}`;
    const confidence = `${(finding.confidence * 100).toFixed(0)}%`;

    console.log(`\n${badge} ${BOLD}${finding.title}${RESET}`);
    console.log(`  Type: ${finding.type} | Confidence: ${confidence} | Analyzer: ${finding.sourceAnalyzer}`);
    console.log(`  ${finding.description}`);

    if (finding.evidence.length > 0) {
      console.log("  Evidence:");
      for (const e of finding.evidence) {
        console.log(`    - ${e.metric}: ${e.value} (${e.context})`);
      }
    }

    if (finding.suggestion) {
      console.log(`  ${BOLD}Suggestion:${RESET} ${finding.suggestion}`);
    }

    if (finding.escalatedToLLM && finding.llmReasoning) {
      console.log(`  LLM reasoning: ${finding.llmReasoning}`);
    }

    return { success: true };
  }
}
