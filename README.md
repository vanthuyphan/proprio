# proprio

Self-evolving software framework. Track how users behave, analyze how your business rules perform, catch bugs before your users report them — and let your software tell you what needs to change, backed by data.

## The idea

Software today is static. You write rules, ship them, and hope they work. When they don't, you find out from bug reports or declining metrics — weeks later.

Proprio adds proprioception to your software. Like the body's ability to sense its own position, proprio lets your app observe its own behavior and propose how to evolve.

**It proposes. You approve. The system evolves.**

## Three layers

### 1. UX Harness — how users actually use your app

Auto-captures behavioral signals:
- Rage clicks (users hammering unresponsive buttons)
- Dwell time (users stuck on a page for too long)
- Flow drop-off (users abandoning multi-step flows)
- Form retries (users resubmitting after unclear errors)
- Workarounds (users encoding structured data in free-text fields)
- Dead features (features nobody touches)
- Emerging workflows (repeated multi-step patterns that should be a shortcut)

### 2. Business Logic Harness — do your rules actually work?

Tracks every decision your code makes and what actually happens:
- **Rule effectiveness** — "Your auto-assign rule has a 16% success rate. It's hurting you."
- **Rule drift** — "This rule worked at 80% three months ago. It's at 30% now. Something changed."
- **Input correlation** — "You weight credit score at 40%, but it has near-zero correlation with conversion. Response time (not in your rule) correlates at 0.7."
- **Rule bias** — "Leads routed to LO #5 convert 20% worse than average."

### 3. Self-Healing Harness — catch and fix bugs automatically

Captures errors with full context and proposes fixes:
- **Error clustering** — groups similar errors by stack trace signature instead of flooding you with duplicates
- **Spike detection** — "This error jumped 10x in the last hour. Likely a regression from a recent deploy."
- **Recurring errors** — "This error has been happening consistently for 7 days. It needs a real fix, not a retry."

## Quick start

```bash
npm install proprio
```

### Track user behavior

```typescript
import { MetaHarness, metaHarnessMiddleware } from "proprio";

const harness = new MetaHarness();

// Auto-track all API routes
app.use(metaHarnessMiddleware(harness, {
  actorFromRequest: (req) => req.user?.id,
}));

// Track behavioral signals
harness.trackRageClick("submit-btn", userId, 7);
harness.trackDwell("/settings", userId, 180000);
harness.trackAbandonment("checkout", 3, 5, userId);
harness.trackFlowStep("onboarding", 2, userId, { duration: 45000 });
harness.trackFieldChange("invoices", "notes", userId, { value: "STATUS: approved" });
```

### Track business decisions

```typescript
// Define what success looks like
harness.registerRule({
  name: "lead.auto_assign",
  description: "Assigns leads to LOs via round-robin",
  inputs: ["creditScore", "loanAmount", "state"],
  possibleOutputs: ["lo_1", "lo_2", "lo_3"],
  successOutcomes: ["converted", "funded"],
  failureOutcomes: ["churned", "defaulted"],
});

// Track every decision
const decisionId = harness.trackDecision({
  rule: "lead.auto_assign",
  inputs: { creditScore: 720, loanAmount: 450000, state: "CA" },
  output: "lo_2",
  actor: "lead-123",
});

// Later, track what actually happened
harness.trackOutcome({
  decisionId,
  result: "converted",
  value: 12500,
});
```

### Capture errors

```typescript
// In your error handler
app.use((err, req, res, next) => {
  harness.captureError(err, {
    route: req.path,
    method: req.method,
    actor: req.user?.id,
    request: { query: req.query, body: req.body },
  });
  next(err);
});
```

Errors are automatically fingerprinted by stack trace signature, so 500 occurrences of the same bug become one finding — not 500 issues.

### Run analysis

```bash
npx proprio analyze
npx proprio analyze --dry-run
npx proprio findings
npx proprio events --since 7d
```

## Built-in analyzers

### UX

| Analyzer | Detects |
|---|---|
| `dead_feature` | Features with zero or near-zero usage |
| `friction` | Rage clicks, flow drop-off, long dwell times, form retries |
| `workaround` | Structured data in free-text fields (users working around missing features) |
| `emerging_workflow` | Repeated multi-step sequences across users |
| `threshold_mismatch` | Business rule thresholds that don't match actual data distributions |

### Business Logic

| Analyzer | Detects |
|---|---|
| `rule_ineffective` | Rules with low success rates |
| `rule_drift` | Rules whose effectiveness has degraded over time |
| `input_correlation` | Inputs that don't predict success, and hidden predictors the rule ignores |
| `rule_bias` | Decision outputs that produce worse outcomes than others |

### Self-Healing

| Analyzer | Detects |
|---|---|
| `error_cluster` | Groups of similar errors with stack traces, affected routes, and user counts |
| `error_spike` | Sudden increase in error rate (likely regression from a deploy) |
| `recurring_error` | Chronic errors present throughout the analysis window |

## Configuration

```bash
npx proprio init
```

Creates `.proprio.json`:

```json
{
  "storage": { "adapter": "sqlite", "path": "./.proprio/events.db" },
  "analyzers": {
    "enabled": [
      "workaround", "dead_feature", "friction", "emerging_workflow",
      "rule_ineffective", "input_correlation", "error_cluster"
    ],
    "window": "7d"
  },
  "llm": { "provider": "claude" },
  "reporters": {
    "enabled": ["github"],
    "github": { "owner": "yourorg", "repo": "yourapp" }
  }
}
```

Set `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` as environment variables.

## How it works

```
Your App ──track()──────────> Proprio SDK ──buffer──> SQLite
         ──trackDecision()──>                           │
         ──captureError()───>                           │
                                                        │
                          npx proprio analyze           │
                                │                       │
                    ┌───────────┴───────────┐           │
                    │  12 Analyzers (rules) │◄──────────┘
                    │  + LLM escalation     │
                    └───────────┬───────────┘
                                │
                          Findings
                                │
                    ┌───────────┴───────────┐
                    │  Reporters            │
                    │  (GitHub Issues, CLI) │
                    └───────────────────────┘
```

1. Your app tracks events, decisions, and errors via the SDK
2. Everything buffers locally (SQLite) — no external service needed
3. Analyzers run deterministic rules to detect patterns
4. Ambiguous cases escalate to Claude for reasoning
5. Findings get reported as GitHub Issues (or console output)

The SDK never throws, buffers in memory, and has zero network overhead. Your app doesn't slow down.

## Reporters

- **Console** — prints findings to stdout (default)
- **GitHub Issues** — creates issues with severity badges, evidence tables, and suggestions. Deduplicates against open issues.

## LLM escalation

When a deterministic rule can't decide (e.g., 25% drop-off — is that friction or natural filtering?), the case gets escalated to Claude. The LLM returns structured findings with reasoning.

LLM is optional. Set `"provider": "none"` to run pure rules.

Cost is predictable: `maxEscalationsPerRun` caps how many cases go to the LLM per analysis (default: 10).

## SDK design principles

- `track()` and `captureError()` **never throw** — errors go to stderr, your app keeps running
- Events buffer in memory, flush in batches — zero impact on app performance
- No outbound network calls from the SDK — all data stays local
- Storage is pluggable (SQLite default, in-memory for testing)
- Analyzers are pluggable — write your own by implementing the `Analyzer` interface
- Reporters are pluggable — GitHub Issues and console included, extend for Slack/email/etc.

## License

MIT
