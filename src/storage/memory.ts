import type {
  StorageAdapter,
  DecisionStorageAdapter,
  BehavioralEvent,
  Finding,
  EventQuery,
  FindingQuery,
  Decision,
  Outcome,
  DecisionQuery,
  OutcomeQuery,
  DecisionWithOutcome,
} from "../types.js";

export class MemoryStorage implements StorageAdapter, DecisionStorageAdapter {
  private events: BehavioralEvent[] = [];
  private findings: Finding[] = [];
  private decisions: Decision[] = [];
  private outcomes: Outcome[] = [];

  async insertEvent(event: BehavioralEvent): Promise<void> {
    this.events.push(event);
  }

  async insertEvents(events: BehavioralEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async queryEvents(query: EventQuery): Promise<BehavioralEvent[]> {
    let results = this.events;

    if (query.since) results = results.filter((e) => e.timestamp >= query.since!);
    if (query.until) results = results.filter((e) => e.timestamp <= query.until!);
    if (query.type) results = results.filter((e) => e.type === query.type);
    if (query.actor) results = results.filter((e) => e.actor === query.actor);
    if (query.flowId) results = results.filter((e) => e.context?.flowId === query.flowId);
    if (query.feature) {
      const pattern = query.feature;
      if (pattern.includes("*")) {
        const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
        results = results.filter((e) => regex.test(e.feature));
      } else {
        results = results.filter((e) => e.feature === pattern);
      }
    }
    if (query.limit) results = results.slice(0, query.limit);

    return results;
  }

  async insertFinding(finding: Finding): Promise<void> {
    this.findings.push(finding);
  }

  async queryFindings(query: FindingQuery): Promise<Finding[]> {
    let results = this.findings;

    if (query.type) results = results.filter((f) => f.type === query.type);
    if (query.reported !== undefined) results = results.filter((f) => f.reported === query.reported);
    if (query.since) results = results.filter((f) => f.analyzedAt >= query.since!);
    if (query.severity) results = results.filter((f) => f.severity === query.severity);
    if (query.limit) results = results.slice(0, query.limit);

    return results;
  }

  async updateFinding(id: string, update: Partial<Finding>): Promise<void> {
    const finding = this.findings.find((f) => f.id === id);
    if (finding) Object.assign(finding, update);
  }

  async getEventCount(feature: string, since: number): Promise<number> {
    return this.events.filter((e) => e.feature === feature && e.timestamp >= since).length;
  }

  async getDistinctActors(feature: string, since: number): Promise<number> {
    const actors = new Set(
      this.events
        .filter((e) => e.feature === feature && e.timestamp >= since)
        .map((e) => e.actor),
    );
    return actors.size;
  }

  async getDistinctFeatures(since: number): Promise<string[]> {
    const features = new Set(
      this.events.filter((e) => e.timestamp >= since).map((e) => e.feature),
    );
    return Array.from(features);
  }

  // ─── Decision Storage ───

  async insertDecision(decision: Decision): Promise<void> {
    this.decisions.push(decision);
  }

  async insertOutcome(outcome: Outcome): Promise<void> {
    this.outcomes.push(outcome);
  }

  async queryDecisions(query: DecisionQuery): Promise<Decision[]> {
    let results = this.decisions;

    if (query.rule) results = results.filter((d) => d.rule === query.rule);
    if (query.output) results = results.filter((d) => d.output === query.output);
    if (query.since) results = results.filter((d) => d.timestamp >= query.since!);
    if (query.until) results = results.filter((d) => d.timestamp <= query.until!);
    if (query.limit) results = results.slice(0, query.limit);

    return results;
  }

  async queryOutcomes(query: OutcomeQuery): Promise<Outcome[]> {
    let results = this.outcomes;

    if (query.decisionId) results = results.filter((o) => o.decisionId === query.decisionId);
    if (query.result) results = results.filter((o) => o.result === query.result);
    if (query.since) results = results.filter((o) => o.timestamp >= query.since!);
    if (query.limit) results = results.slice(0, query.limit);

    return results;
  }

  async getDecisionsWithOutcomes(rule: string, since: number): Promise<DecisionWithOutcome[]> {
    const decisions = this.decisions.filter(
      (d) => d.rule === rule && d.timestamp >= since,
    );

    return decisions.map((decision) => ({
      decision,
      outcome: this.outcomes.find((o) => o.decisionId === decision.id),
    }));
  }

  async getDistinctRules(since: number): Promise<string[]> {
    const rules = new Set(
      this.decisions.filter((d) => d.timestamp >= since).map((d) => d.rule),
    );
    return Array.from(rules);
  }

  async close(): Promise<void> {
    this.events = [];
    this.findings = [];
    this.decisions = [];
    this.outcomes = [];
  }
}
