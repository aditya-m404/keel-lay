# keel-lay · FireWeave ramping tests

Status: plan v2, 6 Nov 2026. Scope: Keel's `local` environment on the laptop, FireWeave staging, metrics produced by Studio's sender (no board traffic), happy paths first. This file is `docs/fireweave-testbed.md` in `aditya-m404/keel-lay` and is updated as scenarios run.

## 1. The flow under test, in FireWeave's terms

- A **control point** is a key Keel's code reads in one place on one surface, anchored `// @fireweave-controlpoint <key>`, default off. Its **manifest** (one control point, one surface, its metrics) is stored on the server from the feature branch, never as a file.
- A **pull request** into the environment branch gets the readiness check. **Merging registers one rollout** for that branch's first environment. A person presses **Start**. Nothing in the repo registers, starts or ramps a rollout.
- A rollout ramps through **steps** (default 10% hold 30 min · 50% hold 1 h · 100%, or the environment's strategy). Each **look** of the soak reads the rollout's metrics from the environment's Metrics account(s): the step so far, 15 minutes at least.
- Metric roles: **Log** (`info`, never acts), **Alert** (`warn`), **Block** (`page`). A Block metric past its absolute limit is a **breach**: the step holds, or rolls back to 0%, as the strategy says.
- **Automatic ramping** needs all of: project automation on, a Metrics provider bound, every named source resolving, a Block metric with an absolute limit, a minimum event count on every Alert and Block metric, data seen in the last 24 h, holds of 15 min or more on every step but the last (`auto-ramp-readiness.ts`).
- **Multi-account metrics**: a default Metrics account per environment plus at most one more account per vendor; a metric names its source by `integrationId`. No vendor query filters by environment, so each environment must point at an account holding only its data.
- **Manual mode**: Ramp up, Ramp down, Resume, Cancel; **Edit schedule** changes future steps (percent, hold, checks), percentages strictly increasing, reached steps locked, a parked step may change its hold and checks. **Switch to automatic** is a check, then a switch, Owner or Admin only.
- "Completed" needs a 24 h stability soak at 100%. Scenarios end at 100% soaking; completion is observed once, overnight.

## 2. Setup

| Piece | Value |
| --- | --- |
| Repo | `aditya-m404/keel-lay`, fork of `fireweave-HQ-Demo/keel` (`upstream`, push disabled). Branch `main` |
| FireWeave | staging; the existing org where the GitHub App is connected through `aditya-m404`; Aditya is Owner/Admin |
| Environment | `local`, exact branch rule `main`, **tier `prod`**, the only environment. (A `dev` tier would install the in-memory provider and nothing would ramp.) |
| Surfaces | `api` (ts-server) and `web`. Test control points live on `api` |
| Metrics | **Studio's sender only.** It posts OTLP to the collector with `keel.signal`, `deployment.environment=local` and the run id. Extended (phase B) to send a chosen **value** per metric and a **kind** (counter or gauge), so a guardrail can be driven to any reading on purpose |
| Vendors | OpenObserve = default Metrics account; Sentry = second source; Datadog = third once connected. The collector's new `multi` mode fans the app pipelines out to every connected vendor |
| Not exercised | Board traffic, journeys, Person mode, the control point's effect under exposure. The rollout's control point is a harmless read, kept only because FireWeave registers rollouts from merged control points |

## 3. Build phases before the first scenario

### A. Onboard `keel-lay` (portal, then one PR)
1. Integrations: GitHub connected through `aditya-m404` and able to see `keel-lay`; OpenObserve and Sentry accounts connected (`keel-lay-*`), Datadog later.
2. New project `keel-lay`: repository `keel-lay` **Managed**; environment `local` on branch `main`, tier `prod`; automation (automatic ramping) on; Metrics binding = OpenObserve; Sentry added as a metrics source.
3. Cloud setup: code analysis → setup PR on `fireweave/setup`. Expected: `AGENTS.md` core, `.fireweave/` instructions, `fireweave.md`, the ts-server harness in the API, the web harness in the web app, `.env.example` names for `FW_API_URL`, `FW_PROJECT_API_KEY`, `PUBLIC_FW_*`. Review, merge. Repo initialised.
4. Keys: Project settings → API keys → project key (server) and browser key (web) into the laptop's `.env` only.
5. `fw` on the Mac: `fw login`, `fw init` in `~/Work/keel` (binds `.fireweave/project.json` to the project). Manifests are authored with `fw tool upsert-rollout-manifest` from inputs prepared in `fireweave-tests/` in the repo.
6. Done when: `./scripts/up` boots with the harness in remote mode, `fw doctor` green, a seeded key reads `false` from fw-server in the API log.

### B. Telemetry the soak can read
1. Collector `multi` (`collector/vendors/multi.yaml`, render changes): app pipelines → every filled vendor (`KEEL_FANOUT_OPENOBSERVE_*`, `KEEL_FANOUT_SENTRY_*`, `KEEL_FANOUT_DATADOG_*`); infra pipelines unchanged. `doctor` records which of metrics, logs, traces each endpoint accepted. `prove` keeps working against OpenObserve.
2. Studio sender, extended and kept honest: each picked metric gets a **value** and a **kind**: `counter` (a cumulative sum that grows by the value each send) or `gauge` (the value as read). Times up to 10 000 and interval from 1 s, so one send can run for hours. A send's run id stays on every point. New catalog entries, `gauge` kind: `keel.guard.error_ratio`, `keel.guard.p95_ms`, `keel.guard.requests_per_min`.
3. Sentry: if OTLP metrics are refused, Sentry stays a source through its span-based built-ins (Keel's API sends traces; a short journey run makes a few). `doctor` says which.
4. Done when: FireWeave's metric catalogue for `local` lists the sent metrics from each source and **Check now** on a draft rollout shows a reading from each.

### C. Control points for the tests
A rollout needs a merged control point, so each scenario merges one tiny PR on the API surface: a read with default `false` in one place, anchored, with no visible effect (a response header `x-keel-cp` when on). Keys are numbered because a merge registers only keys new to the branch and a finished key cannot be rolled out again: `lay.manual.1`, `lay.auto.1`, `lay.breach.1`, … The PR carries the manifest authored on the branch with the metrics below.

Guardrails declared on a rollout (absolute limits, minimum 20 events per look):

| Metric (sent as) | Source | Role | Limit | Healthy send | Breach send |
| --- | --- | --- | --- | --- | --- |
| `keel.guard.error_ratio`, gauge, mean | OpenObserve (default) | Block | > 0.02 | 0.005 | 0.05 |
| `keel.guard.p95_ms`, gauge, max | Sentry (or OpenObserve until Sentry metrics are confirmed) | Block | > 500 | 220 | 900 |
| `keel.card.created`, counter, increase | Datadog when connected, else OpenObserve | Alert | < 30 per look | 1 every 10 s | 0 |
| `keel.guard.requests_per_min`, gauge, last | OpenObserve | Log | — | 300 | 300 |

Every scenario starts a **healthy send** (all four, every 10 s) before Start and keeps it running; a breach is a second send with the breach value for the one metric.

## 4. Scenarios, happy path first

### H1 · Manual ramping (no metrics needed)
1. Merge `lay.manual.1`, rollout intent manual. Start → 0%.
2. Ramp up → 10% → 50% → 100%; Ramp down → 50%; Resume; Cancel a second rollout (`lay.manual.2`) at 10%.
3. Expected: each step shows on the Ramp tab with its time; nothing promotes on its own; the API log shows the key's exposure changing (the harness polls fw-server); Cancel releases the registration (re-roll is offered by the API).

### H2 · Editing the schedule and stages
1. Manual rollout at 10%: Edit schedule → step 2 50 → 30%, hold 1 h → 15 min, append 60%, save → applies from the next step.
2. Refusals to confirm: a step at 5% (below live exposure); editing step 1 (reached); removing the current step.
3. Parked rollout (from H5a): change the current step's hold and checks → allowed.
4. Optional: add a promotion check to a future step and drop it (needs a Custom HTTP account).
5. Expected: the endpoint and the Save button agree with `validateRampScheduleAmendment`.

### H3 · Metrics-based automated rollout
1. Strategy for `local`: 10% (hold 15 min) · 50% (hold 15 min) · 100%, no checks, breach = Hold. Automation on. Healthy send running.
2. Merge `lay.auto.1` with the four guardrails; intent automatic. Start with exposure confirmed.
3. Expected: no readiness blockers; step 1 applied; looks show healthy readings per metric and source; 10 → 50 after 15 min, 50 → 100 after 15 more; stability soak; completed next morning.
4. Negative half, before Start: automation off → blocker `project-auto-release-disabled`; a Block metric with no limit → `no-absolute-block-metric`; a metric without minimum events → `min-samples-missing`; stop the send for 24 h is not practical, so `no-recent-data` is checked with a metric never sent.

### H4 · Multi-account metrics
1. Environment sheet for `local`: default OpenObserve, sources Sentry (and Datadog). One account per vendor offered; the default's vendor not offered.
2. Rollout `lay.multi.1`: Add metric with the Source select, one metric per source; Guardrails rows read "Tool · account · query"; Check now shows a reading per source.
3. Move a metric from Sentry to the default: `integrationId` dropped on the wire.
4. Remove the Sentry source while the rollout is live → `409 SOURCE_IN_USE`; add a source while live → allowed.
5. Readiness names `metric-source-unbound` per metric whose source is missing.

### H5 · Breach
a. Strategy breach = Hold. `lay.breach.1`, automatic, healthy send. After step 1 is applied, start the breach send for `error_ratio` (0.05). Expected within one look: the step parks (`held-after-breach`), the summary names the metric and reading; Resume / Ramp up / Ramp down offered; the switch check answers `held-after-breach`. Stop the breach send, Resume: the next look is healthy, the ramp continues.
b. Strategy breach = Roll back to 0%. `lay.breach.2`, p95 Block at 500: breach send 900. Expected: exposure 0, the rollout says why, the key reads `false`.
c. Alert only: `keel.card.created` send stopped → Alert warns, ramp continues.

### H6 · Switch manual → automatic
1. `lay.switch.1` manual, project automation **off**: mode card says the project does not allow automatic, with the link; no check.
2. Automation on. **Check if it can switch** → blockers with fix links (a step without hold → `ramp-schedule`; a metric whose source is missing → `environment-metrics`; a Block metric without a minimum → `rollout-metrics`). Fix each; **Check again** → `can: true`.
3. **Switch to automatic** at 0% → confirm dialog names step 1 and its exposure; `confirmExposure: true`; step 1 applied.
4. A Writer sees the reason and no check. Resume never switches to automatic.

## 5. Edge cases, after the happy paths
- E1 Send stopped mid-soak → no data → `rollout.soak.unobserved`, hold and page.
- E2 Minimum events above what the send produces → `insufficient-evidence` hold.
- E3 Source removed between looks; vendor outage (endpoint blocked in the collector) mid-soak.
- E4 Metrics edited mid-soak: a Block metric added already over its limit; the only Block metric removed; duplicate name; `VERSION_CONFLICT` from two tabs.
- E5 Two control points in one PR → two rollouts; a key read in two places → readiness `duplicate-key`.
- E6 Merge without a passing readiness check → `merged-without-readiness`; a retired key merged again → nothing registers.
- E7 Edit schedule on a finished rollout → `ROLLOUT_NOT_AMENDABLE`; on the soaking step → locked.
- E8 Automation turned off mid-ramp → parks at the next decide.
- E9 Collector restarted during a soak; a value sent with a wrong metric name.

## 6. Evidence log

| Date | Scenario | Keel run id | Rollout id | Result | Notes |
| --- | --- | --- | --- | --- | --- |

## 7. To confirm before phase A
1. The staging portal URL and the org name.
2. Whether staging runs with `ROLLOUT_CI_MERGE_LAYOUT_V4` and the merge gate on (decides whether a merge into `main` registers for `local` and whether the readiness check is required). Found out from the first merge's report if unknown.
3. `fw` CLI on the Mac (`fw --version`), or the install command for staging.
4. OpenObserve and Sentry send-side credentials for the collector, in `.env` on the laptop only.
