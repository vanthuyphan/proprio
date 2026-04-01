# proprio — Roadmap

## What's built (v0.3.0)

### Three harness layers
- **UX Harness** — rage clicks, dwell time, flow drop-off, form retries, workarounds, dead features, emerging workflows
- **Business Logic Harness** — decision tracking, outcome tracking, rule effectiveness, rule drift, input correlation, rule bias
- **Self-Healing Harness** — error capture, clustering by signature, spike detection, recurring error detection

### Replay Engine
- Simulate rule changes against historical data before deploying
- Predicts success rate and revenue impact
- Flags risks (overload, regression, unknown outputs)

### Two evolution modes
- **Default** — findings → GitHub Issues → human triage → Claude Code fixes
- **Auto-evolve (opt-in)** — findings → LLM reads source → fix diff → PR

### Infrastructure
- SDK with buffered writes, never throws
- SQLite storage (default) + in-memory (testing)
- Console + GitHub Issues reporters
- LLM escalation for ambiguous cases (Claude API, optional)
- CLI: init, analyze, events, findings
- 30 tests passing
- Published on npm as `proprio`
- GitHub: github.com/vanthuyphan/proprio

## What makes proprio different

Existing tools solve pieces of this:
- **Sentry, Datadog** — error tracking ("you have a bug")
- **FullStory, PostHog** — UX analytics ("users clicked here")
- **LaunchDarkly** — feature flags and A/B tests

What nobody does:
- **Business logic harness** — tracking decisions vs outcomes, telling you which rules don't work
- **Workaround detection** — detecting users encoding structured data in free-text fields (missing feature signal)
- **Emerging workflow detection** — detecting repeated multi-step patterns that should be shortcuts
- **Input correlation** — discovering which inputs your rules ignore that actually predict success
- **Replay engine** — simulating rule changes against real historical data with predicted revenue impact
- **One framework that observes behavior, evaluates rules, catches bugs, and proposes its own evolution**

Sentry tells you "you have a bug." PostHog tells you "users clicked here." Proprio tells you "your business rule is failing, here's what to change, and here's what would happen if you do."

## Next up

### Features to build
- [ ] **Auto-instrument** — read codebase, find routes/forms/decision points, add tracking automatically. Zero-config onboarding.
- [ ] **Feedback loop** — after a fix is deployed, track whether it actually worked. "The rule change improved conversion from 20% to 45%."
- [ ] **Frontend SDK** — browser-side auto-capture of rage clicks, dwell, navigation patterns (currently server-side only)
- [ ] **`proprio serve`** — long-running daemon with cron scheduler for periodic analysis
- [ ] **Slack reporter** — post findings to a Slack channel
- [ ] **Aggregate rage clicks** — current friction analyzer creates one finding per rage click event, should aggregate per feature
- [ ] **TypeScript declarations** — re-enable dts generation in tsup (blocked by TS7 compatibility)
- [ ] **Replay CLI command** — `npx proprio simulate --rule order.pricing --file new-logic.js`
- [ ] **Replay comparison view** — side-by-side old vs new rule output in the console
- [ ] **Storage adapter: Postgres** — for production at scale
- [ ] **Storage adapter: HTTP** — post events to a remote collector (for multi-service architectures)
- [ ] **Dashboard** — web UI showing findings, trends, replay results
- [ ] **GitHub Action** — run `proprio analyze` on every PR, comment findings

### Ideas (longer term)
- [ ] **Multi-rule replay** — simulate changing multiple rules at once and see combined impact
- [ ] **A/B rule testing** — split traffic between old and new rule, track which performs better live
- [ ] **Anomaly detection** — detect unusual patterns in events without explicit rules (unsupervised)
- [ ] **Cross-service correlation** — correlate findings across multiple services in a microservice architecture
- [ ] **Natural language rule definition** — define business rules in plain English, LLM translates to code
- [ ] **Proprio for Python** — port the SDK and analyzers to Python

## Design decisions log

- **SQLite as default storage** — no external service to deploy, works everywhere, good enough for thousands of events/day. Pluggable for scale.
- **SDK never throws** — the instrumented app must never break because of proprio. Errors go to stderr.
- **Events buffered in memory** — flush every 100 events or 5 seconds. Keeps tracking calls non-blocking.
- **No network calls from SDK** — all data stays local. Analysis happens out-of-band.
- **Analyzers are deterministic first** — rules catch known patterns cheaply. LLM only handles what rules can't decide.
- **Fix proposals are opt-in** — default mode creates issues for human triage. Auto-evolve is a conscious choice.
- **Replay uses historical outcome rates** — predictions are based on what actually happened with each output, not theoretical models.
