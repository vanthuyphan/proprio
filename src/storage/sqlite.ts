import Database from "better-sqlite3";
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

export class SqliteStorage implements StorageAdapter, DecisionStorageAdapter, ErrorStorageAdapter {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        feature TEXT NOT NULL,
        action TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        context TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_feature ON events(feature);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor);

      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        confidence REAL NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '[]',
        suggestion TEXT,
        analyzed_at INTEGER NOT NULL,
        reported INTEGER NOT NULL DEFAULT 0,
        report_ref TEXT,
        source_analyzer TEXT NOT NULL,
        escalated_to_llm INTEGER NOT NULL DEFAULT 0,
        llm_reasoning TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type);
      CREATE INDEX IF NOT EXISTS idx_findings_reported ON findings(reported);

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        rule TEXT NOT NULL,
        inputs TEXT NOT NULL DEFAULT '{}',
        output TEXT NOT NULL,
        actor TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_rule ON decisions(rule);
      CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);

      CREATE TABLE IF NOT EXISTS outcomes (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        result TEXT NOT NULL,
        value REAL,
        metadata TEXT,
        FOREIGN KEY (decision_id) REFERENCES decisions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_outcomes_decision ON outcomes(decision_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_result ON outcomes(result);

      CREATE TABLE IF NOT EXISTS errors (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        signature TEXT NOT NULL,
        message TEXT NOT NULL,
        stack TEXT NOT NULL,
        kind TEXT NOT NULL,
        route TEXT,
        method TEXT,
        actor TEXT,
        request TEXT,
        metadata TEXT,
        code_context TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_errors_signature ON errors(signature);
      CREATE INDEX IF NOT EXISTS idx_errors_timestamp ON errors(timestamp);
      CREATE INDEX IF NOT EXISTS idx_errors_kind ON errors(kind);
    `);
  }

  async insertEvent(event: BehavioralEvent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO events (id, timestamp, type, actor, feature, action, metadata, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.id,
      event.timestamp,
      event.type,
      event.actor,
      event.feature,
      event.action,
      JSON.stringify(event.metadata),
      event.context ? JSON.stringify(event.context) : null,
    );
  }

  async insertEvents(events: BehavioralEvent[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO events (id, timestamp, type, actor, feature, action, metadata, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((evts: BehavioralEvent[]) => {
      for (const event of evts) {
        stmt.run(
          event.id,
          event.timestamp,
          event.type,
          event.actor,
          event.feature,
          event.action,
          JSON.stringify(event.metadata),
          event.context ? JSON.stringify(event.context) : null,
        );
      }
    });
    insertMany(events);
  }

  async queryEvents(query: EventQuery): Promise<BehavioralEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.since) {
      conditions.push("timestamp >= ?");
      params.push(query.since);
    }
    if (query.until) {
      conditions.push("timestamp <= ?");
      params.push(query.until);
    }
    if (query.type) {
      conditions.push("type = ?");
      params.push(query.type);
    }
    if (query.actor) {
      conditions.push("actor = ?");
      params.push(query.actor);
    }
    if (query.feature) {
      if (query.feature.includes("*")) {
        conditions.push("feature GLOB ?");
        params.push(query.feature);
      } else {
        conditions.push("feature = ?");
        params.push(query.feature);
      }
    }
    if (query.flowId) {
      conditions.push("json_extract(context, '$.flowId') = ?");
      params.push(query.flowId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ? `LIMIT ${query.limit}` : "";
    const sql = `SELECT * FROM events ${where} ORDER BY timestamp DESC ${limit}`;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      timestamp: number;
      type: string;
      actor: string;
      feature: string;
      action: string;
      metadata: string;
      context: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      type: row.type as BehavioralEvent["type"],
      actor: row.actor,
      feature: row.feature,
      action: row.action,
      metadata: JSON.parse(row.metadata),
      context: row.context ? JSON.parse(row.context) : undefined,
    }));
  }

  async insertFinding(finding: Finding): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO findings (id, type, severity, confidence, title, description, evidence, suggestion, analyzed_at, reported, report_ref, source_analyzer, escalated_to_llm, llm_reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      finding.id,
      finding.type,
      finding.severity,
      finding.confidence,
      finding.title,
      finding.description,
      JSON.stringify(finding.evidence),
      finding.suggestion ?? null,
      finding.analyzedAt,
      finding.reported ? 1 : 0,
      finding.reportRef ?? null,
      finding.sourceAnalyzer,
      finding.escalatedToLLM ? 1 : 0,
      finding.llmReasoning ?? null,
    );
  }

  async queryFindings(query: FindingQuery): Promise<Finding[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.type) {
      conditions.push("type = ?");
      params.push(query.type);
    }
    if (query.reported !== undefined) {
      conditions.push("reported = ?");
      params.push(query.reported ? 1 : 0);
    }
    if (query.since) {
      conditions.push("analyzed_at >= ?");
      params.push(query.since);
    }
    if (query.severity) {
      conditions.push("severity = ?");
      params.push(query.severity);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ? `LIMIT ${query.limit}` : "";
    const sql = `SELECT * FROM findings ${where} ORDER BY analyzed_at DESC ${limit}`;

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToFinding(row));
  }

  async updateFinding(id: string, update: Partial<Finding>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (update.reported !== undefined) {
      sets.push("reported = ?");
      params.push(update.reported ? 1 : 0);
    }
    if (update.reportRef !== undefined) {
      sets.push("report_ref = ?");
      params.push(update.reportRef);
    }

    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE findings SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  async getEventCount(feature: string, since: number): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM events WHERE feature = ? AND timestamp >= ?")
      .get(feature, since) as { count: number };
    return row.count;
  }

  async getDistinctActors(feature: string, since: number): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT actor) as count FROM events WHERE feature = ? AND timestamp >= ?")
      .get(feature, since) as { count: number };
    return row.count;
  }

  async getDistinctFeatures(since: number): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT DISTINCT feature FROM events WHERE timestamp >= ?")
      .all(since) as Array<{ feature: string }>;
    return rows.map((r) => r.feature);
  }

  // ─── Decision Storage ───

  async insertDecision(decision: Decision): Promise<void> {
    this.db.prepare(`
      INSERT INTO decisions (id, timestamp, rule, inputs, output, actor, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id,
      decision.timestamp,
      decision.rule,
      JSON.stringify(decision.inputs),
      decision.output,
      decision.actor ?? null,
      decision.metadata ? JSON.stringify(decision.metadata) : null,
    );
  }

  async insertOutcome(outcome: Outcome): Promise<void> {
    this.db.prepare(`
      INSERT INTO outcomes (id, decision_id, timestamp, result, value, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      outcome.id,
      outcome.decisionId,
      outcome.timestamp,
      outcome.result,
      outcome.value ?? null,
      outcome.metadata ? JSON.stringify(outcome.metadata) : null,
    );
  }

  async queryDecisions(query: DecisionQuery): Promise<Decision[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.rule) { conditions.push("rule = ?"); params.push(query.rule); }
    if (query.output) { conditions.push("output = ?"); params.push(query.output); }
    if (query.since) { conditions.push("timestamp >= ?"); params.push(query.since); }
    if (query.until) { conditions.push("timestamp <= ?"); params.push(query.until); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ? `LIMIT ${query.limit}` : "";
    const rows = this.db.prepare(`SELECT * FROM decisions ${where} ORDER BY timestamp DESC ${limit}`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      timestamp: row.timestamp as number,
      rule: row.rule as string,
      inputs: JSON.parse(row.inputs as string),
      output: row.output as string,
      actor: (row.actor as string) ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    }));
  }

  async queryOutcomes(query: OutcomeQuery): Promise<Outcome[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.decisionId) { conditions.push("decision_id = ?"); params.push(query.decisionId); }
    if (query.result) { conditions.push("result = ?"); params.push(query.result); }
    if (query.since) { conditions.push("timestamp >= ?"); params.push(query.since); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ? `LIMIT ${query.limit}` : "";
    const rows = this.db.prepare(`SELECT * FROM outcomes ${where} ORDER BY timestamp DESC ${limit}`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      decisionId: row.decision_id as string,
      timestamp: row.timestamp as number,
      result: row.result as string,
      value: (row.value as number) ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    }));
  }

  async getDecisionsWithOutcomes(rule: string, since: number): Promise<DecisionWithOutcome[]> {
    const rows = this.db.prepare(`
      SELECT d.*, o.id as o_id, o.timestamp as o_timestamp, o.result, o.value as o_value, o.metadata as o_metadata
      FROM decisions d
      LEFT JOIN outcomes o ON o.decision_id = d.id
      WHERE d.rule = ? AND d.timestamp >= ?
      ORDER BY d.timestamp DESC
    `).all(rule, since) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      decision: {
        id: row.id as string,
        timestamp: row.timestamp as number,
        rule: row.rule as string,
        inputs: JSON.parse(row.inputs as string),
        output: row.output as string,
        actor: (row.actor as string) ?? undefined,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      },
      outcome: row.o_id
        ? {
            id: row.o_id as string,
            decisionId: row.id as string,
            timestamp: row.o_timestamp as number,
            result: row.result as string,
            value: (row.o_value as number) ?? undefined,
            metadata: row.o_metadata ? JSON.parse(row.o_metadata as string) : undefined,
          }
        : undefined,
    }));
  }

  async getDistinctRules(since: number): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT DISTINCT rule FROM decisions WHERE timestamp >= ?")
      .all(since) as Array<{ rule: string }>;
    return rows.map((r) => r.rule);
  }

  // ─── Error Storage ───

  async insertError(error: ErrorRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO errors (id, timestamp, signature, message, stack, kind, route, method, actor, request, metadata, code_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      error.id,
      error.timestamp,
      error.signature,
      error.message,
      error.stack,
      error.kind,
      error.route ?? null,
      error.method ?? null,
      error.actor ?? null,
      error.request ? JSON.stringify(error.request) : null,
      error.metadata ? JSON.stringify(error.metadata) : null,
      error.codeContext ? JSON.stringify(error.codeContext) : null,
    );
  }

  async queryErrors(query: ErrorQuery): Promise<ErrorRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.signature) { conditions.push("signature = ?"); params.push(query.signature); }
    if (query.kind) { conditions.push("kind = ?"); params.push(query.kind); }
    if (query.route) { conditions.push("route = ?"); params.push(query.route); }
    if (query.since) { conditions.push("timestamp >= ?"); params.push(query.since); }
    if (query.until) { conditions.push("timestamp <= ?"); params.push(query.until); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ? `LIMIT ${query.limit}` : "";
    const rows = this.db.prepare(`SELECT * FROM errors ${where} ORDER BY timestamp DESC ${limit}`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      timestamp: row.timestamp as number,
      signature: row.signature as string,
      message: row.message as string,
      stack: row.stack as string,
      kind: row.kind as string,
      route: (row.route as string) ?? undefined,
      method: (row.method as string) ?? undefined,
      actor: (row.actor as string) ?? undefined,
      request: row.request ? JSON.parse(row.request as string) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      codeContext: row.code_context ? JSON.parse(row.code_context as string) : undefined,
    }));
  }

  async getErrorClusters(since: number): Promise<ErrorCluster[]> {
    const rows = this.db.prepare(`
      SELECT signature, COUNT(*) as count, MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
      FROM errors WHERE timestamp >= ?
      GROUP BY signature ORDER BY count DESC
    `).all(since) as Array<{ signature: string; count: number; first_seen: number; last_seen: number }>;

    const clusters: ErrorCluster[] = [];

    for (const row of rows) {
      const samples = this.db.prepare(
        `SELECT * FROM errors WHERE signature = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 5`
      ).all(row.signature, since) as Array<Record<string, unknown>>;

      const routes = this.db.prepare(
        `SELECT DISTINCT route FROM errors WHERE signature = ? AND timestamp >= ? AND route IS NOT NULL`
      ).all(row.signature, since) as Array<{ route: string }>;

      const actors = this.db.prepare(
        `SELECT DISTINCT actor FROM errors WHERE signature = ? AND timestamp >= ? AND actor IS NOT NULL`
      ).all(row.signature, since) as Array<{ actor: string }>;

      clusters.push({
        signature: row.signature,
        count: row.count,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        samples: samples.map((s) => ({
          id: s.id as string,
          timestamp: s.timestamp as number,
          signature: s.signature as string,
          message: s.message as string,
          stack: s.stack as string,
          kind: s.kind as string,
          route: (s.route as string) ?? undefined,
          method: (s.method as string) ?? undefined,
          actor: (s.actor as string) ?? undefined,
          request: s.request ? JSON.parse(s.request as string) : undefined,
          metadata: s.metadata ? JSON.parse(s.metadata as string) : undefined,
          codeContext: s.code_context ? JSON.parse(s.code_context as string) : undefined,
        })),
        routes: routes.map((r) => r.route),
        actors: new Set(actors.map((a) => a.actor)),
      });
    }

    return clusters;
  }

  async getErrorCountByWindow(
    signature: string,
    windowMs: number,
    buckets: number,
  ): Promise<number[]> {
    const now = Date.now();
    const bucketSize = windowMs / buckets;
    const counts = new Array(buckets).fill(0) as number[];

    const rows = this.db.prepare(
      `SELECT timestamp FROM errors WHERE signature = ? AND timestamp >= ?`
    ).all(signature, now - windowMs) as Array<{ timestamp: number }>;

    for (const row of rows) {
      const bucket = Math.floor((now - row.timestamp) / bucketSize);
      if (bucket >= 0 && bucket < buckets) counts[buckets - 1 - bucket]++;
    }

    return counts;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private rowToFinding(row: Record<string, unknown>): Finding {
    return {
      id: row.id as string,
      type: row.type as Finding["type"],
      severity: row.severity as Finding["severity"],
      confidence: row.confidence as number,
      title: row.title as string,
      description: row.description as string,
      evidence: JSON.parse(row.evidence as string),
      suggestion: (row.suggestion as string) ?? undefined,
      analyzedAt: row.analyzed_at as number,
      reported: row.reported === 1,
      reportRef: (row.report_ref as string) ?? undefined,
      sourceAnalyzer: row.source_analyzer as string,
      escalatedToLLM: row.escalated_to_llm === 1,
      llmReasoning: (row.llm_reasoning as string) ?? undefined,
    };
  }
}
