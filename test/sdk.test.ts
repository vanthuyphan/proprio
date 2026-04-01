import { describe, it, expect, afterEach } from "vitest";
import { MetaHarness } from "../src/sdk/index.js";
import { MemoryStorage } from "../src/storage/memory.js";

describe("MetaHarness SDK", () => {
  let harness: MetaHarness;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  it("tracks usage events and flushes to storage", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });
    const storage = harness.getStorage() as MemoryStorage;

    harness.trackUsage("invoices.create", "user-1");
    harness.trackUsage("invoices.create", "user-2");
    harness.trackUsage("reports.view", "user-1");

    await harness.flush();

    const events = await storage.queryEvents({});
    expect(events).toHaveLength(3);
    expect(events[0].feature).toBe("invoices.create");
    expect(events[0].type).toBe("interaction");
    expect(events[0].actor).toBe("user-1");
  });

  it("tracks field changes for workaround detection", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });
    const storage = harness.getStorage() as MemoryStorage;

    harness.trackFieldChange("invoices.create", "notes", "user-1", {
      value: "STATUS: approved",
    });

    await harness.flush();

    const events = await storage.queryEvents({ type: "field_mutation" });
    expect(events).toHaveLength(1);
    expect(events[0].metadata.field).toBe("notes");
    expect(events[0].metadata.value).toBe("STATUS: approved");
  });

  it("tracks flow steps for friction detection", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });
    const storage = harness.getStorage() as MemoryStorage;

    harness.trackFlowStep("onboarding", 1, "user-1", { duration: 5000, totalSteps: 4 });
    harness.trackFlowStep("onboarding", 2, "user-1", { duration: 45000, totalSteps: 4 });

    await harness.flush();

    const events = await storage.queryEvents({});
    expect(events).toHaveLength(2);
    expect(events[0].context?.flowId).toBe("onboarding");
    expect(events[0].context?.flowStep).toBe(1);
    expect(events[1].context?.flowStep).toBe(2);
    expect(events[1].context?.duration).toBe(45000);
  });

  it("tracks rage clicks", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });
    const storage = harness.getStorage() as MemoryStorage;

    harness.trackRageClick("submit-button", "user-1", 7);

    await harness.flush();

    const events = await storage.queryEvents({ type: "rage_click" });
    expect(events).toHaveLength(1);
    expect(events[0].metadata.clickCount).toBe(7);
  });

  it("tracks abandonment", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });
    const storage = harness.getStorage() as MemoryStorage;

    harness.trackAbandonment("checkout", 3, 5, "user-1");

    await harness.flush();

    const events = await storage.queryEvents({ type: "abandonment" });
    expect(events).toHaveLength(1);
    expect(events[0].metadata.lastStep).toBe(3);
    expect(events[0].metadata.totalSteps).toBe(5);
    expect(events[0].metadata.completionPct).toBe(0.6);
  });

  it("tracks navigation for emerging workflows", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });
    const storage = harness.getStorage() as MemoryStorage;

    harness.trackNavigation("/invoices", "/reports/aging", "user-1");

    await harness.flush();

    const events = await storage.queryEvents({ type: "navigation" });
    expect(events).toHaveLength(1);
    expect(events[0].context?.route).toBe("/reports/aging");
    expect(events[0].context?.previousRoute).toBe("/invoices");
  });

  it("never throws from tracking methods", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });

    // Should not throw even with weird inputs
    expect(() => harness.trackUsage("", "")).not.toThrow();
    expect(() => harness.trackRageClick("x", "y", -1)).not.toThrow();
    expect(() => harness.trackDwell("x", "y", 0)).not.toThrow();
  });
});
