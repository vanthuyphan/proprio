import { describe, it, expect, afterEach } from "vitest";
import { ulid } from "ulid";
import { MetaHarness } from "../src/sdk/index.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { RuleEffectivenessAnalyzer } from "../src/analyzers/rule-effectiveness.js";
import { InputCorrelationAnalyzer } from "../src/analyzers/input-correlation.js";
import type { Decision, Outcome, RuleDefinition, AnalyzerConfig } from "../src/types.js";

const defaultConfig: AnalyzerConfig = {
  windowMs: 30 * 24 * 60 * 60 * 1000,
  thresholds: {},
  excludeFeatures: [],
};

describe("MetaHarness Decision Tracking", () => {
  let harness: MetaHarness;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  it("tracks decisions and outcomes", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });
    const storage = harness.getStorage() as MemoryStorage;

    const decisionId = harness.trackDecision({
      rule: "lead.auto_assign",
      inputs: { creditScore: 720, loanAmount: 450000 },
      output: "assigned_to_lo_5",
      actor: "lead-123",
    });

    expect(decisionId).toBeTruthy();
    await harness.flush();

    const decisions = await storage.queryDecisions({ rule: "lead.auto_assign" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].output).toBe("assigned_to_lo_5");

    harness.trackOutcome({
      decisionId,
      result: "converted",
      value: 12500,
    });

    // Give async outcome insert a moment
    await new Promise((r) => setTimeout(r, 50));

    const outcomes = await storage.queryOutcomes({ decisionId });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toBe("converted");
    expect(outcomes[0].value).toBe(12500);
  });

  it("registers rule definitions", () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });

    harness.registerRule({
      name: "lead.auto_assign",
      description: "Assigns leads to LOs via round-robin",
      inputs: ["creditScore", "loanAmount", "state"],
      possibleOutputs: ["assigned_to_lo_1", "assigned_to_lo_2"],
      successOutcomes: ["converted", "funded"],
      failureOutcomes: ["churned", "defaulted"],
    });

    expect(harness.getRules().has("lead.auto_assign")).toBe(true);
  });
});

describe("RuleEffectivenessAnalyzer", () => {
  it("detects ineffective rules", async () => {
    const storage = new MemoryStorage();
    const rules = new Map<string, RuleDefinition>();

    rules.set("lead.scoring", {
      name: "lead.scoring",
      description: "Scores leads for priority",
      inputs: ["creditScore"],
      possibleOutputs: ["high", "medium", "low"],
      successOutcomes: ["converted"],
      failureOutcomes: ["churned"],
    });

    const analyzer = new RuleEffectivenessAnalyzer(rules);

    // Insert 30 decisions — only 5 succeed (16% success rate)
    for (let i = 0; i < 30; i++) {
      const decision: Decision = {
        id: ulid(),
        timestamp: Date.now() - i * 60000,
        rule: "lead.scoring",
        inputs: { creditScore: 600 + i * 5 },
        output: i % 3 === 0 ? "high" : "medium",
      };
      await storage.insertDecision(decision);

      const outcome: Outcome = {
        id: ulid(),
        decisionId: decision.id,
        timestamp: Date.now() - i * 60000 + 30000,
        result: i < 5 ? "converted" : "churned",
      };
      await storage.insertOutcome(outcome);
    }

    const result = await analyzer.analyze([], defaultConfig, storage);
    const ineffective = result.findings.filter((f) => f.type === "rule_ineffective");
    expect(ineffective.length).toBeGreaterThanOrEqual(1);
    expect(ineffective[0].title).toContain("lead.scoring");
    expect(ineffective[0].severity).toBe("critical"); // 16% < 20%
  });

  it("detects rule drift", async () => {
    const storage = new MemoryStorage();
    const rules = new Map<string, RuleDefinition>();

    rules.set("pricing.auto", {
      name: "pricing.auto",
      description: "Auto-prices loans",
      inputs: ["amount"],
      possibleOutputs: ["approved"],
      successOutcomes: ["funded"],
      failureOutcomes: ["defaulted"],
    });

    const analyzer = new RuleEffectivenessAnalyzer(rules);
    const now = Date.now();

    // First half: 80% success (early, good)
    for (let i = 0; i < 20; i++) {
      const decision: Decision = {
        id: ulid(),
        timestamp: now - 20 * 86400000 + i * 86400000, // 20 days ago
        rule: "pricing.auto",
        inputs: { amount: 100000 + i * 10000 },
        output: "approved",
      };
      await storage.insertDecision(decision);
      await storage.insertOutcome({
        id: ulid(),
        decisionId: decision.id,
        timestamp: decision.timestamp + 1000,
        result: i < 16 ? "funded" : "defaulted", // 80% success
      });
    }

    // Second half: 30% success (recent, degraded)
    for (let i = 0; i < 20; i++) {
      const decision: Decision = {
        id: ulid(),
        timestamp: now - 5 * 86400000 + i * 3600000, // last 5 days
        rule: "pricing.auto",
        inputs: { amount: 100000 + i * 10000 },
        output: "approved",
      };
      await storage.insertDecision(decision);
      await storage.insertOutcome({
        id: ulid(),
        decisionId: decision.id,
        timestamp: decision.timestamp + 1000,
        result: i < 6 ? "funded" : "defaulted", // 30% success
      });
    }

    const result = await analyzer.analyze([], defaultConfig, storage);
    const drift = result.findings.filter((f) => f.type === "rule_drift");
    expect(drift.length).toBeGreaterThanOrEqual(1);
    expect(drift[0].title).toContain("dropped");
  });
});

describe("InputCorrelationAnalyzer", () => {
  it("detects inputs that don't correlate with success", async () => {
    const storage = new MemoryStorage();
    const rules = new Map<string, RuleDefinition>();

    rules.set("lead.scoring", {
      name: "lead.scoring",
      description: "Scores leads",
      inputs: ["creditScore", "randomField"],
      possibleOutputs: ["high", "low"],
      successOutcomes: ["converted"],
      failureOutcomes: ["churned"],
    });

    const analyzer = new InputCorrelationAnalyzer(rules);

    // Create decisions where creditScore correlates with success but randomField doesn't
    for (let i = 0; i < 50; i++) {
      const creditScore = 500 + i * 10;
      const decision: Decision = {
        id: ulid(),
        timestamp: Date.now() - i * 60000,
        rule: "lead.scoring",
        inputs: {
          creditScore,
          randomField: (i * 7 + 13) % 100, // deterministic noise, no correlation with outcome
        },
        output: creditScore > 700 ? "high" : "low",
      };
      await storage.insertDecision(decision);
      await storage.insertOutcome({
        id: ulid(),
        decisionId: decision.id,
        timestamp: decision.timestamp + 1000,
        // Higher credit score → more likely to convert
        result: creditScore > 650 ? "converted" : "churned",
      });
    }

    const result = await analyzer.analyze([], defaultConfig, storage);
    // Should flag randomField as not correlating
    const findings = result.findings.filter((f) => f.type === "input_correlation");
    expect(findings.length).toBeGreaterThanOrEqual(1);

    const uselessFinding = findings.find((f) => f.title.includes("near-zero correlation"));
    expect(uselessFinding).toBeDefined();
    expect(uselessFinding!.description).toContain("randomField");
  });

  it("detects hidden predictors not used by the rule", async () => {
    const storage = new MemoryStorage();
    const rules = new Map<string, RuleDefinition>();

    rules.set("lead.routing", {
      name: "lead.routing",
      description: "Routes leads to LOs",
      inputs: ["zipCode"],
      possibleOutputs: ["lo_1", "lo_2"],
      successOutcomes: ["converted"],
      failureOutcomes: ["churned"],
    });

    const analyzer = new InputCorrelationAnalyzer(rules);

    // Create decisions where zipCode is used but responseTimeMs (in metadata) is the real predictor
    for (let i = 0; i < 50; i++) {
      const responseTime = 100 + i * 60; // 100ms to 3000ms
      const decision: Decision = {
        id: ulid(),
        timestamp: Date.now() - i * 60000,
        rule: "lead.routing",
        inputs: { zipCode: 90000 + (i % 10) }, // zip doesn't predict success
        output: i % 2 === 0 ? "lo_1" : "lo_2",
        metadata: { responseTimeMs: responseTime },
      };
      await storage.insertDecision(decision);
      await storage.insertOutcome({
        id: ulid(),
        decisionId: decision.id,
        timestamp: decision.timestamp + 1000,
        // Fast response → success. responseTime < 1500ms → converts
        result: responseTime < 1500 ? "converted" : "churned",
      });
    }

    const result = await analyzer.analyze([], defaultConfig, storage);
    const findings = result.findings.filter((f) => f.type === "input_correlation");

    // Should detect responseTimeMs as a hidden predictor
    const hiddenFinding = findings.find((f) => f.title.includes("ignores inputs"));
    expect(hiddenFinding).toBeDefined();
    expect(hiddenFinding!.description).toContain("responseTimeMs");
  });
});
