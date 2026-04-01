import { readFileSync, existsSync } from "fs";
import type { Finding, FixProposal, FileDiff, CodeContext } from "../types.js";

export interface FixGeneratorOptions {
  apiKey: string;
  model?: string;
}

interface LLMFixResponse {
  file: string;
  changes: Array<{
    oldCode: string;
    newCode: string;
    startLine: number;
    endLine: number;
  }>;
  explanation: string;
  confidence: number;
  breaking: boolean;
}

/**
 * Reads source code around a finding, sends it to Claude,
 * and generates a concrete fix proposal with a diff.
 */
export class FixGenerator {
  private apiKey: string;
  private model: string;

  constructor(options: FixGeneratorOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-4-20250514";
  }

  async generateFix(finding: Finding): Promise<FixProposal | null> {
    // Extract code context from finding evidence
    const codeContext = this.extractCodeContext(finding);
    if (!codeContext) return null;

    // Read the source file
    const sourceCode = this.readSourceFile(codeContext.file, codeContext.line);
    if (!sourceCode) return null;

    // Build the prompt
    const prompt = this.buildPrompt(finding, codeContext, sourceCode);

    // Call the LLM
    let Anthropic: typeof import("@anthropic-ai/sdk").default;
    try {
      const mod = await import("@anthropic-ai/sdk");
      Anthropic = mod.default;
    } catch {
      console.error("[proprio] @anthropic-ai/sdk not installed. Cannot generate fixes.");
      return null;
    }

    const client = new Anthropic({ apiKey: this.apiKey });

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Parse the response
    let parsed: LLMFixResponse;
    try {
      // Extract JSON from potential markdown code blocks
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
      if (!jsonMatch) return null;
      parsed = JSON.parse(jsonMatch[1]);
    } catch {
      console.error("[proprio] Failed to parse fix response");
      return null;
    }

    return {
      file: parsed.file || codeContext.file,
      diff: parsed.changes.map((c): FileDiff => ({
        oldCode: c.oldCode,
        newCode: c.newCode,
        startLine: c.startLine,
        endLine: c.endLine,
      })),
      explanation: parsed.explanation,
      confidence: parsed.confidence,
      breaking: parsed.breaking,
    };
  }

  /**
   * Generate fixes for multiple findings at once.
   * Only attempts fixes for findings that have code context.
   */
  async generateFixes(findings: Finding[]): Promise<Map<string, FixProposal>> {
    const fixes = new Map<string, FixProposal>();

    for (const finding of findings) {
      const fix = await this.generateFix(finding);
      if (fix) {
        fixes.set(finding.id, fix);
        // Attach fix to the finding
        finding.fix = fix;
      }
    }

    return fixes;
  }

  private extractCodeContext(finding: Finding): CodeContext | null {
    // Look for source_location in evidence
    const locationEvidence = finding.evidence.find(
      (e) => e.metric === "source_location" || e.metric === "stack_trace",
    );

    if (!locationEvidence) return null;

    const value = String(locationEvidence.value);

    // Try to parse "file:line" or "file:line in functionName"
    const match = value.match(/^(.+):(\d+)(?:\s+in\s+(\w+))?/);
    if (match) {
      return {
        file: match[1],
        line: parseInt(match[2], 10),
        functionName: match[3],
      };
    }

    // Try to extract from stack trace
    const frameMatch = value.match(/at\s+(?:\S+\s+)?\(?(.+):(\d+):(\d+)\)?/);
    if (frameMatch) {
      return {
        file: frameMatch[1],
        line: parseInt(frameMatch[2], 10),
        column: parseInt(frameMatch[3], 10),
      };
    }

    return null;
  }

  private readSourceFile(
    filePath: string,
    errorLine: number,
    contextLines: number = 20,
  ): { content: string; startLine: number; endLine: number } | null {
    if (!existsSync(filePath)) return null;

    try {
      const fullContent = readFileSync(filePath, "utf-8");
      const lines = fullContent.split("\n");

      const startLine = Math.max(0, errorLine - contextLines - 1);
      const endLine = Math.min(lines.length, errorLine + contextLines);
      const slice = lines.slice(startLine, endLine);

      const numbered = slice
        .map((line, i) => {
          const lineNum = startLine + i + 1;
          const marker = lineNum === errorLine ? " >>>" : "    ";
          return `${marker} ${lineNum}: ${line}`;
        })
        .join("\n");

      return { content: numbered, startLine: startLine + 1, endLine };
    } catch {
      return null;
    }
  }

  private buildPrompt(
    finding: Finding,
    codeContext: CodeContext,
    sourceCode: { content: string; startLine: number; endLine: number },
  ): string {
    return `You are a code fix generator for the proprio self-evolving software framework.

A bug or issue has been detected in production. Your job is to analyze the code and propose a minimal, safe fix.

## Finding

**Type:** ${finding.type}
**Severity:** ${finding.severity}
**Title:** ${finding.title}
**Description:** ${finding.description}

**Evidence:**
${finding.evidence.map((e) => `- ${e.metric}: ${e.value} (${e.context})`).join("\n")}

${finding.suggestion ? `**Suggestion:** ${finding.suggestion}` : ""}

## Source Code

**File:** ${codeContext.file}
**Error line:** ${codeContext.line}
${codeContext.functionName ? `**Function:** ${codeContext.functionName}` : ""}

\`\`\`
${sourceCode.content}
\`\`\`

## Instructions

1. Identify the root cause of the issue
2. Propose a minimal fix — change as little code as possible
3. Do NOT refactor or improve unrelated code
4. The fix must be safe — it should not introduce new bugs
5. If you're not confident, set confidence low and breaking to true

Respond with ONLY a JSON object (no markdown wrapper):

{
  "file": "${codeContext.file}",
  "changes": [
    {
      "oldCode": "the exact code to replace (copy from source above)",
      "newCode": "the replacement code",
      "startLine": <line number>,
      "endLine": <line number>
    }
  ],
  "explanation": "why this fix works",
  "confidence": 0.0 to 1.0,
  "breaking": true or false
}`;
  }
}
