import { describe, it, expect, afterEach } from "vitest";
import { ulid } from "ulid";
import { MetaHarness } from "../src/sdk/index.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { replay, formatReplayReport } from "../src/replay/engine.js";
import type { Decision, Outcome, RuleDefinition } from "../src/types.js";

describe("Replay Engine", () => {
  let harness: MetaHarness;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  it("replays decisions through new logic and predicts impact", async () => {
    const storage = new MemoryStorage();

    const ruleDef: RuleDefinition = {
      name: "order.pricing",
      description: "Prices orders",
      inputs: ["quantity"],
      possibleOutputs: ["standard", "bulk_discount"],
      successOutcomes: ["paid"],
      failureOutcomes: ["cancelled"],
    };

    // Insert 40 decisions with the old rule (threshold at 100)
    for (let i = 0; i < 40; i++) {
      const quantity = 50 + i * 5; // 50 to 245
      const decision: Decision = {
        id: ulid(),
        timestamp: Date.now() - i * 60000,
        rule: "order.pricing",
        inputs: { quantity },
        output: quantity > 100 ? "bulk_discount" : "standard",
      };
      await storage.insertDecision(decision);

      // bulk_discount has 60% success, standard has 30% success
      const isBulk = quantity > 100;
      const succeeds = isBulk ? (i % 5 !== 0 && i % 5 !== 1) : (i % 10 < 3);

      await storage.insertOutcome({
        id: ulid(),
        decisionId: decision.id,
        timestamp: decision.timestamp + 1000,
        result: succeeds ? "paid" : "cancelled",
        value: succeeds ? quantity * 10 : 0,
      });
    }

    // New rule: lower threshold from 100 to 70
    const result = await replay({
      storage,
      rule: "order.pricing",
      ruleDef,
      newLogic: (inputs) => {
        const q = inputs.quantity as number;
        return q > 70 ? "bulk_discount" : "standard";
      },
    });

    expect(result.rule).toBe("order.pricing");
    expect(result.decisionsWithOutcomes).toBe(40);
    expect(result.changed).toBeGreaterThan(0);
    expect(result.unchanged).toBeGreaterThan(0);
    expect(result.changed + result.unchanged).toBe(40);

    // Some decisions should shift from standard to bulk_discount
    const toBulk = result.outputChanges.find(
      (c) => c.from === "standard" && c.to === "bulk_discount",
    );
    expect(toBulk).toBeDefined();
    expect(toBulk!.count).toBeGreaterThan(0);

    // Should have sample decisions
    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples[0].originalOutput).not.toBe(result.samples[0].newOutput);
  });

  it("detects when a change would make things worse", async () => {
    const storage = new MemoryStorage();

    const ruleDef: RuleDefinition = {
      name: "lead.routing",
      description: "Routes leads",
      inputs: ["score"],
      possibleOutputs: ["premium", "standard"],
      successOutcomes: ["converted"],
      failureOutcomes: ["churned"],
    };

    // Premium has 80% success, standard has 20%
    for (let i = 0; i < 50; i++) {
      const score = i * 2;
      const isPremium = score > 50;
      const decision: Decision = {
        id: ulid(),
        timestamp: Date.now() - i * 60000,
        rule: "lead.routing",
        inputs: { score },
        output: isPremium ? "premium" : "standard",
      };
      await storage.insertDecision(decision);
      await storage.insertOutcome({
        id: ulid(),
        decisionId: decision.id,
        timestamp: decision.timestamp + 1000,
        result: isPremium ? (i % 5 === 0 ? "churned" : "converted") : (i % 5 === 0 ? "converted" : "churned"),
        value: isPremium ? 1000 : 200,
      });
    }

    // Bad change: send everything to standard
    const result = await replay({
      storage,
      rule: "lead.routing",
      ruleDef,
      newLogic: () => "standard",
    });

    // Should flag this as risky
    expect(result.predictedSuccessRate).toBeLessThan(result.currentSuccessRate);
    expect(result.risks.length).toBeGreaterThan(0);
    expect(result.risks.some((r) => r.includes("lower") || r.includes("worse"))).toBe(true);
  });

  it("works via harness.simulate()", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });

    harness.registerRule({
      name: "test.rule",
      description: "Test",
      inputs: ["x"],
      possibleOutputs: ["a", "b"],
      successOutcomes: ["ok"],
      failureOutcomes: ["fail"],
    });

    // Track some decisions
    for (let i = 0; i < 20; i++) {
      const id = harness.trackDecision({
        rule: "test.rule",
        inputs: { x: i * 10 },
        output: i > 10 ? "a" : "b",
      });
      harness.trackOutcome({
        decisionId: id,
        result: i > 10 ? "ok" : "fail",
        value: i > 10 ? 100 : 0,
      });
    }

    // Wait for async inserts
    await new Promise((r) => setTimeout(r, 100));

    const result = await harness.simulate(
      "test.rule",
      (inputs) => (inputs.x as number) > 50 ? "a" : "b",
      { print: false },
    );

    expect(result.totalDecisions).toBe(20);
    expect(result.decisionsWithOutcomes).toBeGreaterThan(0);
  });

  it("formats a readable report", async () => {
    const storage = new MemoryStorage();

    for (let i = 0; i < 10; i++) {
      const decision: Decision = {
        id: ulid(),
        timestamp: Date.now() - i * 60000,
        rule: "pricing",
        inputs: { amount: i * 100 },
        output: i > 5 ? "high" : "low",
      };
      await storage.insertDecision(decision);
      await storage.insertOutcome({
        id: ulid(),
        decisionId: decision.id,
        timestamp: decision.timestamp + 1000,
        result: i > 5 ? "success" : "failure",
        value: i * 50,
      });
    }

    const result = await replay({
      storage,
      rule: "pricing",
      ruleDef: {
        name: "pricing",
        description: "test",
        inputs: ["amount"],
        possibleOutputs: ["high", "low"],
        successOutcomes: ["success"],
        failureOutcomes: ["failure"],
      },
      newLogic: (inputs) => (inputs.amount as number) > 300 ? "high" : "low",
    });

    const report = formatReplayReport(result);
    expect(report).toContain("Replay Report");
    expect(report).toContain("pricing");
    expect(report).toContain("success rate");
  });
});
