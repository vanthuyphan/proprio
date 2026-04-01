import { ulid } from "ulid";
import type { LLMProvider, AmbiguousCase, Finding } from "../types.js";
import { buildEscalationPrompt, type LLMFindingResponse } from "./prompts.js";

export class ClaudeLLMProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? "claude-sonnet-4-20250514";
  }

  async analyze(cases: AmbiguousCase[]): Promise<Finding[]> {
    if (cases.length === 0) return [];

    let Anthropic: typeof import("@anthropic-ai/sdk").default;
    try {
      const mod = await import("@anthropic-ai/sdk");
      Anthropic = mod.default;
    } catch {
      console.error("[meta-harness] @anthropic-ai/sdk not installed. Skipping LLM escalation.");
      return [];
    }

    const client = new Anthropic({ apiKey: this.apiKey });
    const prompt = buildEscalationPrompt(cases);

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");

    let parsed: LLMFindingResponse[];
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error("[meta-harness] Failed to parse LLM response:", text.slice(0, 200));
      return [];
    }

    const findings: Finding[] = [];

    for (const item of parsed) {
      if (!item.isFinding) continue;

      const originalCase = cases[item.caseIndex];
      if (!originalCase) continue;

      findings.push({
        id: ulid(),
        type: originalCase.type,
        severity: item.confidence >= 0.8 ? "warning" : "info",
        confidence: item.confidence,
        title: item.title,
        description: item.description,
        evidence: originalCase.evidence,
        suggestion: item.suggestion,
        analyzedAt: Date.now(),
        reported: false,
        sourceAnalyzer: originalCase.analyzerName,
        escalatedToLLM: true,
        llmReasoning: item.reasoning,
      });
    }

    return findings;
  }
}
