// ─── Events ───

export interface BehavioralEvent {
  id: string;
  timestamp: number;
  type: EventType;
  actor: string;
  feature: string;
  action: string;
  metadata: Record<string, unknown>;
  context?: EventContext;
}

export type EventType =
  | "interaction"
  | "navigation"
  | "field_mutation"
  | "api_call"
  | "error"
  | "rage_click"
  | "dwell"
  | "abandonment"
  | "back_and_forth"
  | "form_retry"
  | "custom";

export interface EventContext {
  sessionId?: string;
  route?: string;
  previousRoute?: string;
  duration?: number;
  flowId?: string;
  flowStep?: number;
  flowTotalSteps?: number;
  clickCount?: number;
  retryCount?: number;
}

// ─── Findings ───

export interface Finding {
  id: string;
  type: FindingType;
  severity: "info" | "warning" | "critical";
  confidence: number;
  title: string;
  description: string;
  evidence: Evidence[];
  suggestion?: string;
  analyzedAt: number;
  reported: boolean;
  reportRef?: string;
  sourceAnalyzer: string;
  escalatedToLLM: boolean;
  llmReasoning?: string;
}

export type FindingType =
  | "workaround"
  | "dead_feature"
  | "friction"
  | "emerging_workflow"
  | "threshold_mismatch"
  | "rule_ineffective"
  | "rule_drift"
  | "input_correlation"
  | "rule_bias"
  | "custom";

export interface Evidence {
  metric: string;
  value: number | string;
  context: string;
  sampleEvents?: string[];
}

// ─── Analyzer ───

export interface Analyzer {
  name: string;
  type: FindingType;
  analyze(
    events: BehavioralEvent[],
    config: AnalyzerConfig,
    storage: StorageAdapter,
  ): Promise<AnalysisResult>;
}

export interface AnalysisResult {
  findings: Finding[];
  ambiguous: AmbiguousCase[];
}

export interface AmbiguousCase {
  analyzerName: string;
  type: FindingType;
  description: string;
  evidence: Evidence[];
  events: BehavioralEvent[];
}

export interface AnalyzerConfig {
  windowMs: number;
  thresholds: Record<string, number>;
  excludeFeatures: string[];
}

// ─── Storage ───

export interface StorageAdapter {
  insertEvent(event: BehavioralEvent): Promise<void>;
  insertEvents(events: BehavioralEvent[]): Promise<void>;
  queryEvents(query: EventQuery): Promise<BehavioralEvent[]>;
  insertFinding(finding: Finding): Promise<void>;
  queryFindings(query: FindingQuery): Promise<Finding[]>;
  updateFinding(id: string, update: Partial<Finding>): Promise<void>;
  getEventCount(feature: string, since: number): Promise<number>;
  getDistinctActors(feature: string, since: number): Promise<number>;
  getDistinctFeatures(since: number): Promise<string[]>;
  close(): Promise<void>;
}

export interface EventQuery {
  since?: number;
  until?: number;
  type?: EventType;
  feature?: string;
  actor?: string;
  flowId?: string;
  limit?: number;
}

export interface FindingQuery {
  type?: FindingType;
  reported?: boolean;
  since?: number;
  severity?: Finding["severity"];
  limit?: number;
}

// ─── Reporter ───

export interface Reporter {
  name: string;
  report(finding: Finding): Promise<ReportResult>;
}

export interface ReportResult {
  success: boolean;
  ref?: string;
  error?: string;
}

// ─── LLM Provider ───

export interface LLMProvider {
  analyze(cases: AmbiguousCase[]): Promise<Finding[]>;
}

// ─── Business Logic Decisions ───

export interface Decision {
  id: string;
  timestamp: number;
  rule: string;             // Name of the rule: "lead.auto_assign", "loan.auto_approve"
  inputs: Record<string, unknown>;   // What the rule evaluated: { creditScore: 720, loanAmount: 450000 }
  output: string;           // What the rule decided: "approved", "routed_to_lo_5", "priced_at_4.5"
  actor?: string;           // Who/what was the subject of the decision
  metadata?: Record<string, unknown>;
}

export interface Outcome {
  id: string;
  decisionId: string;       // Links back to the decision
  timestamp: number;
  result: string;           // What actually happened: "converted", "defaulted", "churned"
  value?: number;           // Quantitative result: revenue, loss amount, time-to-close
  metadata?: Record<string, unknown>;
}

export interface RuleDefinition {
  name: string;             // "lead.auto_assign"
  description: string;      // Human-readable: "Assigns leads to LOs via round-robin"
  inputs: string[];         // Expected input fields: ["creditScore", "loanAmount", "state"]
  possibleOutputs: string[]; // ["approved", "rejected", "manual_review"]
  successOutcomes: string[]; // Which outcomes mean the rule worked: ["converted", "funded"]
  failureOutcomes: string[]; // Which outcomes mean it didn't: ["defaulted", "churned"]
}

// Extended storage for business logic
export interface DecisionStorageAdapter {
  insertDecision(decision: Decision): Promise<void>;
  insertOutcome(outcome: Outcome): Promise<void>;
  queryDecisions(query: DecisionQuery): Promise<Decision[]>;
  queryOutcomes(query: OutcomeQuery): Promise<Outcome[]>;
  getDecisionsWithOutcomes(rule: string, since: number): Promise<DecisionWithOutcome[]>;
  getDistinctRules(since: number): Promise<string[]>;
}

export interface DecisionQuery {
  rule?: string;
  output?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface OutcomeQuery {
  decisionId?: string;
  result?: string;
  since?: number;
  limit?: number;
}

export interface DecisionWithOutcome {
  decision: Decision;
  outcome?: Outcome;
}

// ─── Config ───

export interface MetaHarnessConfig {
  storage?: {
    adapter?: "sqlite" | "memory";
    path?: string;
  };
  analyzers?: {
    enabled?: FindingType[];
    window?: string;
    thresholds?: Record<string, number>;
    excludeFeatures?: string[];
  };
  llm?: {
    provider?: "claude" | "none";
    apiKey?: string;
    model?: string;
    maxEscalationsPerRun?: number;
  };
  reporters?: {
    enabled?: string[];
    github?: {
      token?: string;
      owner: string;
      repo: string;
      labels?: string[];
    };
  };
  schedule?: {
    cron?: string;
    timezone?: string;
  };
  buffer?: {
    maxSize?: number;
    flushIntervalMs?: number;
  };
}
