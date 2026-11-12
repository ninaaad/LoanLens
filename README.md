# LoanLens

A product-manager workbench for a digital personal-loan funnel. It shows a PM **what broke, why, what to change, whether the change is compliant, and how to test it**, in one place.

> **Synthetic data.** Every applicant, event, API call and experiment in this repository is generated. LoanLens is a portfolio prototype, **not a real lending system and not legal advice**. The UI shows a banner saying so on every page, and API responses carry `synthetic: true` where it applies.

<!-- Screenshots: add images to docs/img/ and link them here (funnel, RCA for 13 Oct, simulator, compliance, experiment brief). -->

## The loop

| Stage | Question | What LoanLens does |
|---|---|---|
| Detect | Where did it drop? | Daily step-conversion anomaly detection: 14-day median baseline, robust z-score, plus a minimum 3-point drop |
| Diagnose | Why? | Root-cause analysis joins funnel events with provider API latency, app releases, credit-policy changes and traffic mix, and ranks each hypothesis by the share of the drop it would explain on its own |
| Decide | What should we change? | What-if simulator replays stored applications through a baseline and a candidate ruleset and shows conversion next to expected NPA |
| Check | Is it allowed? | Question answering over the RBI Digital Lending Directions with clause citations (extractive; see the limits below) |
| Experiment | Did it work? | A/B framework with a sample-ratio check, guardrails and an auto-drafted ship / hold / stop brief |

Around the loop sits a small working lending journey (apply, KYC, eligibility, offer with a Key Fact Statement, accept) driven by a **deterministic, versioned rules engine**, plus mock bureau and KYC providers whose latency and failures you can inject.

## Quick start

Requirements: Node 20 or newer (developed on Node 24, Windows 11). No Docker and no separate database are needed; the API starts its own embedded PostgreSQL.

```bash
npm install
npm run dev
```

- API on <http://localhost:4000>, web app on <http://localhost:5173> (Vite proxies `/api` and `/mock`).
- On first start the API creates the embedded database in `.data/pg`, seeds the synthetic dataset (about 27,000 applications over 40 days from 10 Sep 2026; takes roughly a minute) and indexes the RBI document. Later starts reuse it.
- Production-style single process: `npm run build`, then `npm start -w server` serves the built UI and the API on port 4000.
- Check everything: `npm run check` (all tests, then the production build).
- Reset the data: `POST /api/admin/reseed` (also removes applications created through the journey), or delete `.data/`.

Optional environment variables (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 4000 | API port |
| `DATABASE_URL` | none | Use an external PostgreSQL instead of the embedded one |
| `EMBEDDED_PG_PORT` | 54330 | Port of the embedded PostgreSQL |
| `LOANLENS_DATA_DIR` | `.data/pg` | Where the embedded database lives |
| `LATENCY_SCALE` | 0.02 | Shrinks simulated provider latency so demos feel quick (recorded latency stays nominal) |
| `LLM_PROVIDER` | `none` | `none` or `anthropic`; see "Optional language model" |

## Try it in five minutes

See [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md). In short: open **Workbench > Anomalies**, pick 13 Oct, and the RCA ranks the bureau slowdown first while the iOS release that morning is ruled out; change the FOIR cap in the **Simulator**; ask the **Compliance** tab about the cooling-off period; open the **Experiments** tab for a ship decision.

## Architecture

```
Web (React + Vite + Recharts)  --- REST /api --->  Express API (Node.js, ESM)
                                                    journey/     start -> KYC -> eligibility -> offer (KFS) -> accept
                                                    rules/       versioned JSON rulesets, deterministic engine
                                                    analytics/   loadApps -> funnel -> anomaly -> rca ; simulate
                                                    rag/         ingest -> search (FTS + BM25) -> answer
                                                    experiments/ assign -> analyse -> brief
                                                    llm/         optional, phrasing only
                                                    integrations/providerClient (timeout, one retry, fallback to "refer")
                                                    mock/        bureau + KYC providers, incident controls
                                                         |
                                                    PostgreSQL (embedded, or DATABASE_URL)
                                                    applications, events, api_calls, releases, rule_versions,
                                                    rag_chunks (tsvector + GIN), experiments, experiment_units
```

- **Analytics are plain JavaScript over rows.** `loadApps` aggregates events and provider waits per application once; the funnel, detector, RCA and simulator are pure functions over those rows, which makes them easy to test and explain.
- **The rules engine decides; nothing else does.** Approve, refer and reject come only from `rules/engine.js` with reason codes. The optional language model can reword a summary and can never change a number, a ranking or a decision.
- **Provider calls degrade safely.** If the mock bureau times out, the journey retries once and then refers the application with `BUREAU_UNAVAILABLE` instead of failing.

## API

All paths are under `http://localhost:4000`.

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Liveness and database check |
| `POST /api/applications` | Start an application |
| `POST /api/applications/:id/kyc`, `/eligibility`, `/offer`, `/accept` | Journey steps; the offer includes the KFS |
| `GET /api/applications/:id` | Application and its event trail |
| `GET /api/rules`, `POST /api/rules` | Rulesets (v1: FOIR cap 55%; v2: 50% from 29 Sep 2026) |
| `GET /api/releases`, `GET /api/meta` | Release list, data range, rulesets |
| `GET /api/funnel?from=&to=&segment=&value=` | Daily and total funnel, segment breakdowns |
| `GET /api/anomalies` | Flagged days and the per-step series |
| `GET /api/rca?day=&step=` | Ranked hypotheses, evidence, decomposition, narrative |
| `POST /api/simulate` | Replay a candidate ruleset against a baseline |
| `POST /api/compliance/ask`, `GET /api/compliance/sources` | Cited answers over the RBI Directions |
| `GET/POST /api/experiments`, `POST /api/experiments/demo`, `POST /:key/run`, `GET /:key/analysis`, `GET /:key/brief` | Experiments |
| `GET /api/mock/status`, `POST /api/mock/config`, `POST /api/mock/scenarios/:name` | Incident injection with validation |
| `POST /mock/bureau/score`, `POST /mock/kyc/verify`, `GET/POST /mock/config`, `POST /mock/reset` | The mock providers themselves |
| `POST /api/admin/reseed` | Regenerate the synthetic dataset |

Load generator: `npm run live-load -- --n 200 --concurrency 4` sends fabricated journeys through the real API; add `--scenario bureau_slowdown --from 60 --to 140` to inject an incident mid-run.

### Errors and input checking
Every error is JSON: `{ "error": "message" }`, with `"errors": [...]` when there are several reasons. Bad input is a 400 (or 404 for an id that cannot exist, 409 for a duplicate, 413 for a body over 1 MB, 422 when there is not enough data), unknown `/api` and `/mock` paths are a JSON 404, and a server fault is a generic 500: the real error is logged on the server only, so no stack trace, SQL or file path reaches a client. Dates must be real calendar dates, ids positive integers, text fields short plain strings, and query parameters may not be repeated.

## What the synthetic data contains

Forty days of traffic with four planted stories, so there is a known answer to test against:

1. **Android 2.3 KYC regression**, 6 Oct 10:00 to 8 Oct 15:00 IST (hotfix 2.3.1).
2. **Bureau slowdown**, 13 Oct 11:00 to 19:00 IST (5x latency plus timeouts).
3. **A decoy iOS 5.2 release** the same morning, which changes nothing in the funnel.
4. **Credit policy v2** from 29 Sep: the FOIR cap goes from 55% to 50%, a step change in rejections rather than a dip.

Because the applicants are invented, the generator also knows who would default. A real lender never sees that for rejected applicants, so simulator NPA figures are a synthetic advantage, labelled as such.

## Measured results

Numbers below come from runs of this repository. They are measurements on synthetic data, not targets.

**Anomaly detector** (full dataset): flags 6 day-steps. Five map to the planted stories (29 Sep, 6 Oct, 7 Oct, 8 Oct, 13 Oct). One, **5 Oct (offer viewed, z = -4.2), has no day-specific planted cause**: it falls six days after the policy change, so it is a chance flag that may be partly the lasting policy effect. The RCA for that day shows a small 19% "possible" score for the policy change, a known artefact: within 14 days after a policy change the baseline overlaps the pre-change period. The sustained-shift detector reports two episodes on this data: the policy change (29 Sep to 5 Oct) and the Android regression (3 to 10 Oct).

**RCA on the planted stories:** 13 Oct (offer viewed) ranks the bureau slowdown first at 100% and rules out both releases and the policy change; 7 Oct (KYC completed) ranks Android 2.3 first at 100%.

**Compliance retrieval** (20 labelled questions plus 6 out-of-scope ones; details in [`docs/RAG_EVAL.md`](docs/RAG_EVAL.md)):

| Ranker | Clause hit@1 | Clause hit@3 |
|---|---|---|
| `ts_rank_cd` (first baseline) | 55% (11/20) | 85% (17/20) |
| BM25 over the same candidates (default) | **85% (17/20)** | **90% (18/20)** |

Six of six out-of-scope questions were refused. **Read this caveat:** the BM25 ranker and the refusal threshold were chosen after looking at this same question set (the questions were not edited), so these figures are optimistic, twenty questions is a small sample (one question is 5 points), and the margin around the threshold is thin (0.341 vs 0.361). Two questions miss at rank 3, one of them because the Directions spell out "Default Loss Guarantee" while the question says "DLG".

**On a second, held-out set** of 20 questions written after the design was fixed and never used for tuning: clause hit@1 **85%**, hit@3 **90%** (the first ranker: 25% and 60%), but only **4 of 6 out-of-scope questions were refused** ("tenure of a home loan" and "capital of France" got answers because the Directions contain those words). Ranking generalises; refusal is the weak spot. Details and misses in [`docs/RAG_EVAL.md`](docs/RAG_EVAL.md).

**Experiment framework** (`node scripts/evaluate-experiments.mjs`, 150 repeats per row, 40,000 users, 50/50): the 95% interval contained the true effect 93 to 95% of the time. With no effect the rule shipped 1.3%, held 94.7% and **stopped 4.0%** (a significantly negative fluke or a guardrail breach by chance). A +1 point effect shipped 48%, +2 points 97%, +3 points 99%. A +2 points win with a +3 points default rate stopped 99%. A 10% logging loss was caught by the sample-ratio check every time. At this size the test can reliably detect about 1.4 points; the analysis and the brief say so.

**Detector and RCA, re-rolled** (`node scripts/evaluate-detector.mjs`, 8 draws of the generator with other seeds, never touching your data): the daily detector found the Android regression and the bureau slowdown in every draw, but the FOIR policy change in only 2 of 8 (a lasting few-point shift hides in day-to-day noise); a separate sustained-shift detector found it in 7 of 8 with no unexplained episodes (its settings were chosen on these same draws). The RCA ranked the true cause first on all 32 Android and bureau incident days of those draws.

**Tests:** 131 passing (server 109 on `node:test`, web 22 on Vitest). `npm test` runs both and takes roughly three minutes, mostly seeding databases. `node scripts/evaluate.mjs` runs a further 170 checks across the whole product on a throwaway database; the eight evaluation loops are written up in [`docs/IMPROVEMENT_LOOPS.md`](docs/IMPROVEMENT_LOOPS.md). `npm run build` builds the UI, and `npm run check` runs the tests and the build together. A copy of the repository without `node_modules` or `.data`, installed with `npm install`, passed `npm run check` (S8).

## Optional language model

Off by default. With `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` set, a model may reword three things: the RCA narrative, a summary line on the experiment brief, and the compliance answer. Every model output is checked: it is used only if every number in it appears in the evidence (a minus sign may be dropped but not added), the required citation or decision text survives, it is under 1,500 characters and at least 60% of its content words occur in the evidence; otherwise the template is used. The key is read from the environment only. **This path has been tested only against a fake HTTP client, never against the real API.** The ranking, scores, decisions, and "not found" are always computed by code.

## Honest limitations

- **Synthetic data.** Effects are what the generator puts in. Detection and diagnosis working on invented stories shows the method works, not that it would on a real lender's data. Default risk is a hand-set formula, so absolute NPA levels (about 1.4% in the simulator) are not calibrated to anything real.
- **Detector:** the daily detector flags one day with no day-specific cause (5 Oct), inside the week after the policy change, so it may be partly the same effect; in 8 re-rolled draws it raised no flag outside that kind of window. It misses a lasting few-point shift on its own (the shift detector covers it, with settings tuned on those draws). The RCA scores are counterfactual shares under a model, can overlap (a shared shock that hits one platform harder by chance can still mislead the release check), and are correlation, not proof of causation.
- **Language model checks** catch changed numbers, a gained minus sign, over-long output and answers made of words that are not in the evidence. They do not catch a reversed direction word ("rose" for "fell") or a subtle wrong cause made of the evidence's own words.
- **Simulator:** replays past applicants under a new ruleset; it does not model applicants changing behaviour, and bureau outages are ignored (incident-day applicants are scored as if the bureau answered). Referred applications are not counted as disbursals.
- **Compliance answers:** extractive and lexical (no embeddings), so vocabulary mismatches miss. The source PDF is stamped **Withdrawn**; verify the instruction currently in force. Not legal advice. Footnotes are not indexed and the Annex II numeric table is garbled by text extraction.
- **Experiments:** a single look at the data, no sequential-testing or multiple-comparison correction, two variants only; the complaint metric is a simulated proxy; cohorts are generated, not real traffic.
- **Language model:** the number check cannot catch spelled-out numbers or wrong causal wording, and the real API path is unverified.
- **Prototype scope:** no authentication (so `POST /api/admin/reseed`, which wipes and regenerates the data, and `POST /api/rules`, which changes the credit policy, are open to anyone who can reach the port; run it locally only), no real KYC or bureau integration, mock provider state lives in process memory, the UI has no end-to-end browser test, and accessibility has not been audited. The in-process rate limiter in `server/src/mock/rateLimit.js` is a small stand-in for the mock providers only.
- **Dependencies:** `npm audit` reports no vulnerabilities in runtime dependencies. It reports six in development tooling (Vite, esbuild, Vitest and related packages) that only a major-version upgrade fixes; they affect the dev server and test runner, not the built app.
- The `docker-compose.yml` in the repository is optional and not used by the app or the tests.

## Repository map

```
server/src/   config, db, rules, journey, mock, integrations, data (generator), analytics, rag, experiments, llm
server/test/  node:test suites (rules, journey, analytics, simulate, rag, experiments, mock controls, llm)
web/src/      React app: pages for Journey and each workbench tab
data/rbi/     the RBI Directions PDF used for retrieval
scripts/      live-load.js
docs/         PRD, metric tree, demo script, interview Q&A, RAG evaluation, build spec, progress log
```

Further reading: [`docs/PRD.md`](docs/PRD.md), [`docs/METRIC_TREE.md`](docs/METRIC_TREE.md), [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md), [`docs/INTERVIEW_QA.md`](docs/INTERVIEW_QA.md), [`docs/RAG_EVAL.md`](docs/RAG_EVAL.md), [`docs/PROGRESS.md`](docs/PROGRESS.md).
