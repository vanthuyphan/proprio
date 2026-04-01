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
  fix?: FixProposal;
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
  | "error_cluster"
  | "error_spike"
  | "recurring_error"
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

// ─── Error Tracking (Self-Healing) ───

export interface ErrorRecord {
  id: string;
  timestamp: number;
  signature: string;        // Normalized stack trace fingerprint for clustering
  message: string;
  stack: string;
  kind: string;             // Error class: "TypeError", "ValidationError", etc.
  route?: string;           // API route or page that triggered it
  method?: string;          // HTTP method
  actor?: string;
  request?: Record<string, unknown>;   // Sanitized request context
  metadata?: Record<string, unknown>;
  codeContext?: CodeContext;
}

export interface CodeContext {
  file: string;             // Source file path
  line: number;
  column?: number;
  functionName?: string;
  snippet?: string;         // Surrounding lines of code
}

export interface ErrorCluster {
  signature: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  samples: ErrorRecord[];
  routes: string[];
  actors: Set<string>;
}

export interface ErrorStorageAdapter {
  insertError(error: ErrorRecord): Promise<void>;
  queryErrors(query: ErrorQuery): Promise<ErrorRecord[]>;
  getErrorClusters(since: number): Promise<ErrorCluster[]>;
  getErrorCountByWindow(
    signature: string,
    windowMs: number,
    buckets: number,
  ): Promise<number[]>;
}

export interface ErrorQuery {
  signature?: string;
  kind?: string;
  route?: string;
  since?: number;
  until?: number;
  limit?: number;
}

// ─── Fix Proposals ───

export interface FixProposal {
  file: string;              // File to change
  diff: FileDiff[];          // One or more changes in the file
  explanation: string;       // Why this fix works
  confidence: number;        // 0-1 how confident the LLM is
  breaking: boolean;         // Could this change break other things?
}

export interface FileDiff {
  oldCode: string;           // The code to replace
  newCode: string;           // The replacement
  startLine: number;         // Where in the file
  endLine: number;
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

// ─── Replay Engine ───

export type RuleFunction = (inputs: Record<string, unknown>) => string;

export interface ReplayResult {
  rule: string;
  totalDecisions: number;
  decisionsWithOutcomes: number;
  changed: number;                    // Decisions that would have a different output
  unchanged: number;

  // Impact prediction
  currentSuccessRate: number;
  predictedSuccessRate: number;
  successDelta: number;               // positive = improvement

  currentRevenue: number;
  predictedRevenue: number;
  revenueDelta: number;

  // Breakdown by output
  outputChanges: OutputChange[];

  // Risk flags
  risks: string[];

  // Individual replayed decisions (sample)
  samples: ReplayedDecision[];
}

export interface OutputChange {
  from: string;
  to: string;
  count: number;
  currentSuccessRate: number;
  predictedSuccessRate: number;
}

export interface ReplayedDecision {
  decisionId: string;
  inputs: Record<string, unknown>;
  originalOutput: string;
  newOutput: string;
  actualOutcome?: string;
  actualValue?: number;
  predictedOutcome?: string;
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
