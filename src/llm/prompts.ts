import type { AmbiguousCase } from "../types.js";

export function buildEscalationPrompt(cases: AmbiguousCase[]): string {
  const casesText = cases
    .map(
      (c, i) => `
## Case ${i + 1}: ${c.type}
**Analyzer:** ${c.analyzerName}
**Observation:** ${c.description}

**Evidence:**
${c.evidence.map((e) => `- ${e.metric}: ${e.value} (${e.context})`).join("\n")}

**Sample events (${c.events.length}):**
${c.events
  .slice(0, 5)
  .map((e) => `- [${e.type}] ${e.feature} / ${e.action} by ${e.actor} — metadata: ${JSON.stringify(e.metadata)}`)
  .join("\n")}
`,
    )
    .join("\n---\n");

  return `You are a behavioral analysis engine for a self-evolving software framework called meta-harness.

You are given ambiguous cases that deterministic rules could not classify. For each case, decide whether it represents a real finding that the product team should act on.

${casesText}

For each case, respond with a JSON array. Each element should have:
- caseIndex: number (0-based)
- isFinding: boolean
- confidence: number (0-1)
- title: string (concise finding title)
- description: string (what's happening and why it matters)
- suggestion: string (what should change)
- reasoning: string (why you classified it this way)

Only mark isFinding: true if the pattern genuinely suggests a product gap, not noise.
Respond with ONLY the JSON array, no other text.`;
}

export interface LLMFindingResponse {
  caseIndex: number;
  isFinding: boolean;
  confidence: number;
  title: string;
  description: string;
  suggestion: string;
  reasoning: string;
}
