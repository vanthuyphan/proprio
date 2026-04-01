import { describe, it, expect, afterEach } from "vitest";
import { ulid } from "ulid";
import { MetaHarness } from "../src/sdk/index.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { ErrorClusterAnalyzer } from "../src/analyzers/error-cluster.js";
import type { ErrorRecord, AnalyzerConfig } from "../src/types.js";

const defaultConfig: AnalyzerConfig = {
  windowMs: 7 * 24 * 60 * 60 * 1000,
  thresholds: {},
  excludeFeatures: [],
};

function makeError(overrides: Partial<ErrorRecord>): ErrorRecord {
  return {
    id: ulid(),
    timestamp: Date.now(),
    signature: "err_abc123",
    message: "Cannot read property 'id' of undefined",
    stack: `TypeError: Cannot read property 'id' of undefined
    at getUser (/app/src/users.ts:42:15)
    at handler (/app/src/routes/api.ts:18:10)`,
    kind: "TypeError",
    ...overrides,
  };
}

describe("MetaHarness Error Capture", () => {
  let harness: MetaHarness;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  it("captures errors with auto-generated signature", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });
    const storage = harness.getStorage() as MemoryStorage;

    const error = new TypeError("Cannot read property 'id' of undefined");
    harness.captureError(error, {
      route: "/api/users/123",
      method: "GET",
      actor: "user-1",
    });

    // Wait for async insert
    await new Promise((r) => setTimeout(r, 50));

    const errors = await storage.queryErrors({});
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("TypeError");
    expect(errors[0].route).toBe("/api/users/123");
    expect(errors[0].signature).toMatch(/^err_/);
  });

  it("generates same signature for same error", async () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });
    const storage = harness.getStorage() as MemoryStorage;

    const error1 = new TypeError("Cannot read property 'id' of undefined");
    const error2 = new TypeError("Cannot read property 'id' of undefined");

    harness.captureError(error1, { route: "/api/a" });
    harness.captureError(error2, { route: "/api/b" });

    await new Promise((r) => setTimeout(r, 50));

    const errors = await storage.queryErrors({});
    expect(errors).toHaveLength(2);
    // Same error type+message from same stack shape → same signature
    expect(errors[0].signature).toBe(errors[1].signature);
  });

  it("never throws from captureError", () => {
    harness = new MetaHarness({ storage: { adapter: "memory" } });
    expect(() => harness.captureError(new Error(""))).not.toThrow();
    expect(() => harness.captureError({} as Error)).not.toThrow();
  });
});

describe("ErrorClusterAnalyzer", () => {
  it("detects error clusters", async () => {
    const storage = new MemoryStorage();
    const analyzer = new ErrorClusterAnalyzer();

    // Insert 15 similar errors
    for (let i = 0; i < 15; i++) {
      await storage.insertError(
        makeError({
          timestamp: Date.now() - i * 60000,
          route: "/api/users",
          actor: `user-${i % 5}`,
        }),
      );
    }

    const result = await analyzer.analyze([], defaultConfig, storage);
    const clusters = result.findings.filter((f) => f.type === "error_cluster");
    expect(clusters).toHaveLength(1);
    expect(clusters[0].title).toContain("15x");
    expect(clusters[0].evidence.some((e) => e.metric === "stack_trace")).toBe(true);
  });

  it("detects error spikes", async () => {
    const storage = new MemoryStorage();
    const analyzer = new ErrorClusterAnalyzer();
    const now = Date.now();
    const windowMs = defaultConfig.windowMs;
    const bucketSize = windowMs / 6;

    // Few errors in early buckets
    for (let bucket = 0; bucket < 5; bucket++) {
      for (let i = 0; i < 2; i++) {
        await storage.insertError(
          makeError({
            timestamp: now - windowMs + bucket * bucketSize + i * 1000,
          }),
        );
      }
    }

    // Many errors in the latest bucket (spike)
    for (let i = 0; i < 20; i++) {
      await storage.insertError(
        makeError({
          timestamp: now - bucketSize / 2 + i * 1000,
        }),
      );
    }

    const result = await analyzer.analyze([], defaultConfig, storage);
    const spikes = result.findings.filter((f) => f.type === "error_spike");
    expect(spikes.length).toBeGreaterThanOrEqual(1);
    expect(spikes[0].severity).toBe("critical");
  });

  it("detects recurring errors", async () => {
    const storage = new MemoryStorage();
    const analyzer = new ErrorClusterAnalyzer();
    const now = Date.now();
    const windowMs = defaultConfig.windowMs;
    const bucketSize = windowMs / 6;

    // Consistent errors across all 6 buckets
    for (let bucket = 0; bucket < 6; bucket++) {
      for (let i = 0; i < 3; i++) {
        await storage.insertError(
          makeError({
            timestamp: now - windowMs + bucket * bucketSize + i * 60000,
          }),
        );
      }
    }

    const result = await analyzer.analyze([], defaultConfig, storage);
    const recurring = result.findings.filter((f) => f.type === "recurring_error");
    expect(recurring.length).toBeGreaterThanOrEqual(1);
    expect(recurring[0].title).toContain("Recurring");
  });

  it("skips small clusters below threshold", async () => {
    const storage = new MemoryStorage();
    const analyzer = new ErrorClusterAnalyzer();

    // Only 2 errors — below default threshold of 5
    await storage.insertError(makeError({}));
    await storage.insertError(makeError({}));

    const result = await analyzer.analyze([], defaultConfig, storage);
    expect(result.findings).toHaveLength(0);
  });
});
