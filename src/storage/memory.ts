import type {
  StorageAdapter,
  DecisionStorageAdapter,
  ErrorStorageAdapter,
  BehavioralEvent,
  Finding,
  EventQuery,
  FindingQuery,
  Decision,
  Outcome,
  DecisionQuery,
  OutcomeQuery,
  DecisionWithOutcome,
  ErrorRecord,
  ErrorQuery,
  ErrorCluster,
} from "../types.js";

export class MemoryStorage implements StorageAdapter, DecisionStorageAdapter, ErrorStorageAdapter {
  private events: BehavioralEvent[] = [];
  private findings: Finding[] = [];
  private decisions: Decision[] = [];
  private outcomes: Outcome[] = [];
  private errors: ErrorRecord[] = [];

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

  // ─── Error Storage ───

  async insertError(error: ErrorRecord): Promise<void> {
    this.errors.push(error);
  }

  async queryErrors(query: ErrorQuery): Promise<ErrorRecord[]> {
    let results = this.errors;

    if (query.signature) results = results.filter((e) => e.signature === query.signature);
    if (query.kind) results = results.filter((e) => e.kind === query.kind);
    if (query.route) results = results.filter((e) => e.route === query.route);
    if (query.since) results = results.filter((e) => e.timestamp >= query.since!);
    if (query.until) results = results.filter((e) => e.timestamp <= query.until!);
    if (query.limit) results = results.slice(0, query.limit);

    return results;
  }

  async getErrorClusters(since: number): Promise<ErrorCluster[]> {
    const recent = this.errors.filter((e) => e.timestamp >= since);
    const clusterMap = new Map<string, ErrorCluster>();

    for (const error of recent) {
      if (!clusterMap.has(error.signature)) {
        clusterMap.set(error.signature, {
          signature: error.signature,
          count: 0,
          firstSeen: error.timestamp,
          lastSeen: error.timestamp,
          samples: [],
          routes: [],
          actors: new Set(),
        });
      }
      const cluster = clusterMap.get(error.signature)!;
      cluster.count++;
      if (error.timestamp < cluster.firstSeen) cluster.firstSeen = error.timestamp;
      if (error.timestamp > cluster.lastSeen) cluster.lastSeen = error.timestamp;
      if (cluster.samples.length < 5) cluster.samples.push(error);
      if (error.route && !cluster.routes.includes(error.route)) cluster.routes.push(error.route);
      if (error.actor) cluster.actors.add(error.actor);
    }

    return Array.from(clusterMap.values()).sort((a, b) => b.count - a.count);
  }

  async getErrorCountByWindow(
    signature: string,
    windowMs: number,
    buckets: number,
  ): Promise<number[]> {
    const now = Date.now();
    const bucketSize = windowMs / buckets;
    const counts = new Array(buckets).fill(0) as number[];

    const matching = this.errors.filter(
      (e) => e.signature === signature && e.timestamp >= now - windowMs,
    );

    for (const error of matching) {
      const bucket = Math.floor((now - error.timestamp) / bucketSize);
      if (bucket >= 0 && bucket < buckets) counts[buckets - 1 - bucket]++;
    }

    return counts;
  }

  async close(): Promise<void> {
    this.events = [];
    this.findings = [];
    this.decisions = [];
    this.outcomes = [];
    this.errors = [];
  }
}
