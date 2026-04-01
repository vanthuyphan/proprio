import { ulid } from "ulid";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type {
  BehavioralEvent,
  EventType,
  EventContext,
  MetaHarnessConfig,
  StorageAdapter,
  DecisionStorageAdapter,
  Decision,
  Outcome,
  RuleDefinition,
} from "../types.js";
import { mergeConfig } from "../config.js";
import { SqliteStorage } from "../storage/sqlite.js";
import { MemoryStorage } from "../storage/memory.js";

export class MetaHarness {
  private storage: StorageAdapter;
  private buffer: BehavioralEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private config: Required<MetaHarnessConfig>;
  private closed = false;

  constructor(config?: MetaHarnessConfig) {
    this.config = mergeConfig(config ?? {});
    this.storage = this.createStorage();
    this.startFlushTimer();
  }

  // ─── Core tracking ───

  track(params: {
    type: EventType;
    feature: string;
    action: string;
    actor: string;
    metadata?: Record<string, unknown>;
    context?: EventContext;
  }): void {
    try {
      const event: BehavioralEvent = {
        id: ulid(),
        timestamp: Date.now(),
        type: params.type,
        actor: params.actor,
        feature: params.feature,
        action: params.action,
        metadata: params.metadata ?? {},
        context: params.context,
      };
      this.buffer.push(event);
      if (this.buffer.length >= this.config.buffer.maxSize) {
        this.flush().catch(() => {});
      }
    } catch {
      // SDK never throws
    }
  }

  // ─── Convenience methods ───

  trackUsage(feature: string, actor: string, metadata?: Record<string, unknown>): void {
    this.track({ type: "interaction", feature, action: "use", actor, metadata });
  }

  trackFieldChange(
    feature: string,
    field: string,
    actor: string,
    params?: { value?: unknown },
  ): void {
    this.track({
      type: "field_mutation",
      feature,
      action: "field_change",
      actor,
      metadata: { field, value: params?.value },
    });
  }

  trackFlowStep(
    flowId: string,
    step: number,
    actor: string,
    params?: { duration?: number; totalSteps?: number },
  ): void {
    this.track({
      type: "interaction",
      feature: `flow.${flowId}`,
      action: "flow_step",
      actor,
      context: {
        flowId,
        flowStep: step,
        flowTotalSteps: params?.totalSteps,
        duration: params?.duration,
      },
    });
  }

  trackNavigation(from: string, to: string, actor: string): void {
    this.track({
      type: "navigation",
      feature: to,
      action: "navigate",
      actor,
      context: { route: to, previousRoute: from },
    });
  }

  // ─── Auto-captured behavioral signals ───

  trackRageClick(feature: string, actor: string, clickCount: number): void {
    this.track({
      type: "rage_click",
      feature,
      action: "rage_click",
      actor,
      metadata: { clickCount },
      context: { clickCount },
    });
  }

  trackDwell(feature: string, actor: string, durationMs: number): void {
    this.track({
      type: "dwell",
      feature,
      action: "dwell",
      actor,
      metadata: { durationMs },
      context: { duration: durationMs },
    });
  }

  trackAbandonment(
    flowId: string,
    lastStep: number,
    totalSteps: number,
    actor: string,
  ): void {
    this.track({
      type: "abandonment",
      feature: `flow.${flowId}`,
      action: "abandon",
      actor,
      metadata: { lastStep, totalSteps, completionPct: lastStep / totalSteps },
      context: { flowId, flowStep: lastStep, flowTotalSteps: totalSteps },
    });
  }

  trackBackAndForth(routes: string[], actor: string): void {
    this.track({
      type: "back_and_forth",
      feature: routes[routes.length - 1],
      action: "back_and_forth",
      actor,
      metadata: { routes, bounceCount: routes.length },
    });
  }

  trackFormRetry(feature: string, actor: string, retryCount: number): void {
    this.track({
      type: "form_retry",
      feature,
      action: "form_retry",
      actor,
      metadata: { retryCount },
      context: { retryCount },
    });
  }

  trackError(feature: string, actor: string, error: { message: string; code?: string }): void {
    this.track({
      type: "error",
      feature,
      action: "error",
      actor,
      metadata: { errorMessage: error.message, errorCode: error.code },
    });
  }

  trackApiCall(
    route: string,
    method: string,
    actor: string,
    params?: { statusCode?: number; durationMs?: number },
  ): void {
    this.track({
      type: "api_call",
      feature: `${method.toUpperCase()} ${route}`,
      action: "api_call",
      actor,
      metadata: { method, route, statusCode: params?.statusCode, durationMs: params?.durationMs },
      context: { route, duration: params?.durationMs },
    });
  }

  // ─── Business Logic Decisions ───

  private rules = new Map<string, RuleDefinition>();
  private decisionBuffer: Decision[] = [];

  registerRule(rule: RuleDefinition): void {
    this.rules.set(rule.name, rule);
  }

  trackDecision(params: {
    rule: string;
    inputs: Record<string, unknown>;
    output: string;
    actor?: string;
    metadata?: Record<string, unknown>;
  }): string {
    try {
      const decision: Decision = {
        id: ulid(),
        timestamp: Date.now(),
        rule: params.rule,
        inputs: params.inputs,
        output: params.output,
        actor: params.actor,
        metadata: params.metadata,
      };
      this.decisionBuffer.push(decision);
      if (this.decisionBuffer.length >= this.config.buffer.maxSize) {
        this.flushDecisions().catch(() => {});
      }
      return decision.id;
    } catch {
      return "";
    }
  }

  trackOutcome(params: {
    decisionId: string;
    result: string;
    value?: number;
    metadata?: Record<string, unknown>;
  }): void {
    try {
      const outcome: Outcome = {
        id: ulid(),
        decisionId: params.decisionId,
        timestamp: Date.now(),
        result: params.result,
        value: params.value,
        metadata: params.metadata,
      };
      const ds = this.storage as StorageAdapter & DecisionStorageAdapter;
      if (ds.insertOutcome) {
        ds.insertOutcome(outcome).catch(() => {});
      }
    } catch {
      // SDK never throws
    }
  }

  getRules(): Map<string, RuleDefinition> {
    return this.rules;
  }

  private async flushDecisions(): Promise<void> {
    if (this.decisionBuffer.length === 0) return;
    const batch = this.decisionBuffer.splice(0);
    const ds = this.storage as StorageAdapter & DecisionStorageAdapter;
    if (!ds.insertDecision) return;
    try {
      for (const decision of batch) {
        await ds.insertDecision(decision);
      }
    } catch {
      this.decisionBuffer.unshift(...batch);
    }
  }

  // ─── Storage access (for analyzers) ───

  getStorage(): StorageAdapter {
    return this.storage;
  }

  getConfig(): Required<MetaHarnessConfig> {
    return this.config;
  }

  // ─── Lifecycle ───

  async flush(): Promise<void> {
    if (this.buffer.length === 0 && this.decisionBuffer.length === 0) return;

    if (this.buffer.length > 0) {
      const batch = this.buffer.splice(0);
      try {
        await this.storage.insertEvents(batch);
      } catch {
        this.buffer.unshift(...batch);
      }
    }

    await this.flushDecisions();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
    await this.storage.close();
  }

  // ─── Private ───

  private createStorage(): StorageAdapter {
    const { adapter, path } = this.config.storage;
    if (adapter === "memory") return new MemoryStorage();

    const dbPath = path ?? "./.proprio/events.db";
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return new SqliteStorage(dbPath);
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.config.buffer.flushIntervalMs);
    // Don't block process exit
    if (this.flushTimer.unref) this.flushTimer.unref();
  }
}
