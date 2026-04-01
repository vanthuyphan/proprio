import { describe, it, expect } from "vitest";
import { ulid } from "ulid";
import { MemoryStorage } from "../src/storage/memory.js";
import { DeadFeatureAnalyzer } from "../src/analyzers/dead-feature.js";
import { FrictionAnalyzer } from "../src/analyzers/friction.js";
import { WorkaroundAnalyzer } from "../src/analyzers/workaround.js";
import { EmergingWorkflowAnalyzer } from "../src/analyzers/emerging-workflow.js";
import type { BehavioralEvent, AnalyzerConfig } from "../src/types.js";

function makeEvent(overrides: Partial<BehavioralEvent>): BehavioralEvent {
  return {
    id: ulid(),
    timestamp: Date.now(),
    type: "interaction",
    actor: "user-1",
    feature: "test.feature",
    action: "use",
    metadata: {},
    ...overrides,
  };
}

const defaultConfig: AnalyzerConfig = {
  windowMs: 7 * 24 * 60 * 60 * 1000,
  thresholds: {},
  excludeFeatures: [],
};

describe("DeadFeatureAnalyzer", () => {
  it("detects features with zero recent usage", async () => {
    const storage = new MemoryStorage();
    const analyzer = new DeadFeatureAnalyzer();

    // Insert old events (outside analysis window)
    const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 15; i++) {
      await storage.insertEvent(makeEvent({ feature: "old.feature", timestamp: oldTime }));
    }

    // No recent events for this feature
    const events: BehavioralEvent[] = [];

    const result = await analyzer.analyze(events, defaultConfig, storage);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0].type).toBe("dead_feature");
    expect(result.findings[0].title).toContain("old.feature");
  });
});

describe("FrictionAnalyzer", () => {
  it("detects rage clicks", async () => {
    const storage = new MemoryStorage();
    const analyzer = new FrictionAnalyzer();

    const events = [
      makeEvent({
        type: "rage_click",
        feature: "submit-btn",
        action: "rage_click",
        metadata: { clickCount: 7 },
        context: { clickCount: 7 },
      }),
    ];

    const result = await analyzer.analyze(events, defaultConfig, storage);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0].title).toContain("Rage clicks");
  });

  it("detects flow drop-off", async () => {
    const storage = new MemoryStorage();
    const analyzer = new FrictionAnalyzer();

    const events: BehavioralEvent[] = [];
    // 10 users reach step 1
    for (let i = 0; i < 10; i++) {
      events.push(
        makeEvent({
          feature: "flow.checkout",
          actor: `user-${i}`,
          context: { flowId: "checkout", flowStep: 1, duration: 5000 },
        }),
      );
    }
    // Only 3 users reach step 2 (70% drop-off)
    for (let i = 0; i < 3; i++) {
      events.push(
        makeEvent({
          feature: "flow.checkout",
          actor: `user-${i}`,
          context: { flowId: "checkout", flowStep: 2, duration: 6000 },
        }),
      );
    }

    const result = await analyzer.analyze(events, defaultConfig, storage);
    const dropOffFinding = result.findings.find((f) => f.title.includes("drop-off"));
    expect(dropOffFinding).toBeDefined();
    expect(dropOffFinding!.severity).toBe("critical");
  });

  it("detects form retries", async () => {
    const storage = new MemoryStorage();
    const analyzer = new FrictionAnalyzer();

    const events = [
      makeEvent({
        type: "form_retry",
        feature: "login-form",
        action: "form_retry",
        metadata: { retryCount: 4 },
        context: { retryCount: 4 },
      }),
    ];

    const result = await analyzer.analyze(events, defaultConfig, storage);
    expect(result.findings.some((f) => f.title.includes("Form retry"))).toBe(true);
  });
});

describe("WorkaroundAnalyzer", () => {
  it("detects structured data in free-text fields", async () => {
    const storage = new MemoryStorage();
    const analyzer = new WorkaroundAnalyzer();

    const events: BehavioralEvent[] = [];
    // Create field mutations with structured content
    for (let i = 0; i < 10; i++) {
      events.push(
        makeEvent({
          type: "field_mutation",
          feature: "invoices.create",
          action: "field_change",
          actor: `user-${i}`,
          metadata: { field: "notes", value: `STATUS: ${i % 2 ? "approved" : "pending"}` },
        }),
      );
    }
    // Add some normal notes
    for (let i = 0; i < 5; i++) {
      events.push(
        makeEvent({
          type: "field_mutation",
          feature: "invoices.create",
          action: "field_change",
          actor: `user-${i}`,
          metadata: { field: "notes", value: "Just a regular note about this invoice" },
        }),
      );
    }

    const result = await analyzer.analyze(events, defaultConfig, storage);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0].type).toBe("workaround");
    expect(result.findings[0].title).toContain("notes");
  });
});

describe("EmergingWorkflowAnalyzer", () => {
  it("detects repeated navigation sequences", async () => {
    const storage = new MemoryStorage();
    const analyzer = new EmergingWorkflowAnalyzer();

    const events: BehavioralEvent[] = [];
    const now = Date.now();

    // 5 different users follow the same 3-step sequence multiple times
    for (let user = 0; user < 5; user++) {
      for (let repeat = 0; repeat < 3; repeat++) {
        const base = now + user * 10000 + repeat * 3000;
        events.push(
          makeEvent({
            type: "navigation",
            feature: "/invoices",
            actor: `user-${user}`,
            timestamp: base,
          }),
          makeEvent({
            type: "navigation",
            feature: "/reports/aging",
            actor: `user-${user}`,
            timestamp: base + 1000,
          }),
          makeEvent({
            type: "navigation",
            feature: "/export",
            actor: `user-${user}`,
            timestamp: base + 2000,
          }),
        );
      }
    }

    const result = await analyzer.analyze(events, defaultConfig, storage);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0].type).toBe("emerging_workflow");
  });
});
