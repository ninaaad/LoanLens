# LoanLens: Project Description and Build Spec for Claude Code

A PM workbench for a digital-lending funnel. This file is the single source of truth for what LoanLens is, how it fits together, and the ordered steps for Claude Code to finish building it. Hand this file to Claude Code at the start of every session.

> **Ground rules for whoever executes this spec (read first)**
> 1. **Git:** never run `git add/commit/push`. The owner (Ninad) does all git work. Only create and edit files in the project folder.
> 2. **Honesty:** all data is synthetic and must be labelled so in the UI, API responses and docs. Never claim in docs or on the resume something that is not built and tested.
> 3. **No Rate Limiter / TaskForge claims.** They are separate projects of the owner. LoanLens only has a small in-process stand-in limiter (`server/src/mock/rateLimit.js`). Do not describe them as integrated unless they actually are.
> 4. **The LLM never makes a credit decision.** Only the deterministic rules engine approves, refers or rejects. An LLM (optional) may only phrase explanations and summaries.
> 5. **Measured, not claimed:** report real numbers from the test runs (hit rate, false alarms, etc.), including misses. Never hard-code a target as a result.
> 6. **Keep it runnable:** after every step, `npm test` must pass and `npm run dev` must start.
> 7. **No deadline.** There is no time limit on this project. Prioritise correctness, clarity and test coverage over speed. Do not skip, shorten or stub any step, and do not cut scope to finish sooner. Finish each step properly before starting the next.

---

## 1. What LoanLens is

**One line:** LoanLens is a product-manager workbench for a digital personal-loan funnel. It shows the PM what broke, why, what to change, whether the change is compliant, and how to test it.

**The problem.** In a digital lender, a PM watches a funnel (apply, KYC, eligibility, offer, accept, disburse). When conversion drops, the PM today chases analysts, engineers and the risk team across separate dashboards to answer four questions: *Where did it drop? Why? What should we change without raising bad loans? Is that change allowed under RBI rules?* Each answer lives in a different tool, so incidents take days to diagnose.

**The loop LoanLens implements**

| Stage | Question | What the product does |
|---|---|---|
| Detect | Where did it drop? | Daily step-conversion anomaly detection (rolling baseline, z-score plus minimum drop) |
| Diagnose | Why? | RCA joins funnel events with provider API latency/errors, releases and rule changes, and ranks hypotheses by counterfactual share of the drop explained |
| Decide | What should we change? | What-if simulator replays stored applications through a candidate ruleset and shows conversion and expected NPA together |
| Check | Is it compliant? | RAG assistant over the RBI Digital Lending Directions with clause citations |
| Experiment | Did it work? | A/B framework with guardrail metrics and an auto-drafted decision brief |

**Who uses it:** a lending product manager (primary), with risk and compliance as reviewers.

**What makes it different from existing tools** (Mixpanel/Amplitude funnels, Datadog-style monitoring, vendor BRE/LOS consoles, generic RAG chatbots): each solves one box of the loop. LoanLens connects the boxes with lending-specific logic (reason codes, FOIR, bureau/KYC dependencies, credit risk next to conversion, RBI citations) in one place.

**Scope honesty.** It is a portfolio-grade prototype on synthetic data, not a production lending system and not legal advice.

### 1.1 Domain glossary (for interviews)
- **Funnel / conversion:** share of users who reach the next step.
- **Bureau score:** credit score (e.g. CIBIL) pulled from a credit bureau; here a mock API.
- **KYC:** identity verification; here a mock API.
- **FOIR:** fixed obligations to income ratio = (existing EMI + new EMI) / monthly income.
- **EMI:** equated monthly instalment. **APR:** annualised cost incl. fees (illustrative method here).
- **KFS:** Key Fact Statement, the standard loan-terms sheet the borrower must see before accepting.
- **NPA:** non-performing asset (a loan that has gone bad). Here: expected default share of disbursed amount.
- **BRE:** business rules engine. **Reason codes:** machine-readable reasons for a decision.
- **TAT:** turnaround time. **RE/LSP/DLA:** regulated entity, lending service provider, digital lending app (RBI terms).
- **MAD / z-score:** robust spread and standardised deviation used by the detector.

---

## 2. Current status (verified: 21/21 tests passing on 20 Oct 2026)

### 2.1 Already built (do not rewrite; extend)
| Area | Files | Notes |
|---|---|---|
| Config, DB | `server/src/config.js`, `db/connection.js`, `db/migrate.js`, `db/migrations/001_init.sql`, `002_rag_experiments.sql` | Embedded Postgres by default; `DATABASE_URL` for external |
| Rules engine | `rules/engine.js`, `defaultRules.js`, `kfs.js` | Versioned JSON rulesets (v1 FOIR 55%, v2 FOIR 50% from 29 Sep 2026); two stages: prescreen, credit |
| Mock providers | `mock/*` (bureau, KYC, state, stand-in rate limiter) | Latency, errors, timeouts, idempotency |
| Provider client | `integrations/providerClient.js` | Timeout, one retry, fallback to refer `BUREAU_UNAVAILABLE` |
| Journey API | `journey/service.js`, `routes.js` | start, kyc, eligibility, offer (with KFS), accept |
| Synthetic data | `data/generate.js`, `data/seed.js` | 40 days from 10 Sep 2026, about 27k applications, seeded scenarios (below) |
| Analytics | `analytics/data.js`, `funnel.js`, `anomaly.js`, `rca.js`, `routes.js` | `/api/meta`, `/api/funnel`, `/api/anomalies`, `/api/rca`, `/api/admin/reseed` |
| Server | `app.js`, `index.js` | Seeds automatically on an empty DB |
| Tests | `server/test/*.test.js` | rules (8), journey (6), analytics (7) |

**Seeded scenarios (IST):** Android v2.3 KYC regression 6 Oct 10:00 to 8 Oct 15:00 (hotfix 2.3.1); bureau slowdown 13 Oct 11:00 to 19:00 (x5 latency, timeouts); harmless iOS 5.2 release 13 Oct 09:00 (decoy); FOIR cap 55% to 50% from 29 Sep.

**Measured detector behaviour (honest numbers to quote):** flags 6 days; 5 map to seeded events (29 Sep, 6, 7, 8 Oct, 13 Oct), 1 (5 Oct) is a chance false alarm (4 sigma outlier, no seeded cause). RCA limitation: for days within 14 days after a policy change the baseline partly overlaps the pre-change period, so the policy hypothesis can show a small "possible" score (e.g. 19% on 5 Oct).

### 2.2 Still to build (this spec's steps S1 to S9)
Simulator, RAG over the RBI PDF, experiment framework, mock-controls API, React workbench UI, optional LLM switch, docs (README, PRD, metric tree, demo script, interview Q&A), hardening, claims audit.

---

## 3. Architecture

```
                       +---------------------------+
                       |  Web (React + Vite)       |
                       |  Journey page             |
                       |  Workbench: Funnel |      |
                       |  Anomalies | RCA |        |
                       |  Simulator | Compliance | |
                       |  Experiments | Mock ctrl  |
                       +-------------+-------------+
                                     | REST /api
+------------------------------------v------------------------------------+
|                         Express API (Node.js ESM)                         |
|                                                                           |
|  journey/        rules/           analytics/            rag/    experiments/
|  start->kyc->    engine (BRE)     data -> funnel ->     ingest  assign
|  eligibility->   versions         anomaly -> rca        search  analyse
|  offer(KFS)->    kfs              simulate              answer  brief
|  accept                                                                   |
|        |              ^                  ^                                |
|        v              |                  |                                |
|  integrations/providerClient  ----->  /mock (bureau, KYC, stand-in limiter)
|   (timeout, 1 retry, idempotency,     latency/error/timeout injection     |
|    fallback -> refer)                                                     |
+-------------------------------+-------------------------------------------+
                                |
                      +---------v----------+
                      |     PostgreSQL     |
                      | applications       |  events | api_calls | releases |
                      | rule_versions      |  rag_chunks (tsvector + GIN)   |
                      | experiments        |  schema_migrations             |
                      +--------------------+
Optional: LLM provider (LLM_PROVIDER=none|anthropic) used ONLY to phrase
summaries/answers from retrieved evidence. Never for credit decisions.
```

### 3.1 Data flow
1. **Live journey:** UI/API creates an application, then KYC (provider call), prescreen rules, then offer generation (bureau call with retry/fallback, credit rules, KFS), then accept. Every step writes an `events` row; every provider call writes an `api_calls` row.
2. **Analytics:** `loadApps` aggregates events per application into flags/timings; funnel, anomaly, RCA and simulator are pure JS over those rows (easy to unit-test and explain).
3. **RCA:** for (day, step) it computes a counterfactual "share of the drop explained" for each hypothesis: provider latency (dose-response by wait time), each recent release (difference-in-differences vs other platforms), each policy change (replay under previous ruleset), and traffic-mix shift. Output includes evidence strings, a timeline, a decomposition (abandoned vs rejected vs referred) and a template narrative.
4. **Simulator (to build):** replay stored applications through baseline vs candidate ruleset; report decision mix, expected disbursals, expected NPA.
5. **Compliance RAG (to build):** PDF text is cleaned and chunked by clause, stored with a Postgres FTS index; a question retrieves top chunks, the answer is extractive with citations, and "not found" is returned below a rank threshold.
6. **Experiments (to build):** deterministic hash assignment, guardrails, significance test, SRM check, decision brief.

### 3.2 API surface (existing and planned)
- Existing: `POST /api/applications`, `POST /api/applications/:id/{kyc,eligibility,offer,accept}`, `GET /api/applications/:id`, `GET/POST /api/rules`, `GET /api/releases`, `GET /api/meta`, `GET /api/funnel`, `GET /api/anomalies`, `GET /api/rca?day=&step=`, `POST /api/admin/reseed`, `GET/POST /mock/config`, `POST /mock/reset`, `GET /api/health`.
- Planned: `POST /api/simulate`, `POST /api/compliance/ask`, `GET /api/compliance/sources`, `GET/POST /api/experiments`, `GET /api/experiments/:key/analysis`, `GET /api/experiments/:key/brief`.

---

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 (ESM) | One language end to end |
| API | Express, cors | Simple, familiar |
| DB | PostgreSQL 18 via `embedded-postgres` (no Docker needed); `DATABASE_URL` for external; optional `docker-compose.yml` (pgvector) | Zero-setup demo, real Postgres semantics |
| Driver | `pg` | Plain SQL, bulk `unnest` inserts |
| Tests | `node:test` | No extra dependency |
| Retrieval | Postgres full-text search (tsvector + GIN) first; pgvector embeddings optional later | Works offline; honest baseline |
| Frontend (to build) | React + Vite + Recharts | Fast charts, standard stack |
| LLM (optional) | Provider switch `LLM_PROVIDER=none|anthropic` | App must work with no key |

Do not add Redis, BullMQ or Docker as hard requirements.

---

## 5. Execution plan for Claude Code

Work through the steps in order, completing each one fully (implementation, tests, docs) before moving on. After each: run `npm test`, run the app once, and write a short note in `docs/PROGRESS.md` (what was built, test counts, known gaps). Do not use git.

### S0. Orientation
- Read this file, `package.json`, `server/package.json`, and skim `server/src/**`.
- Run `npm install`, then `npm test` in `server/`. Expect 21 passing. If embedded Postgres fails to start on Windows, fall back to `DATABASE_URL` pointing at a local Postgres or the docker-compose DB; document what worked in `docs/PROGRESS.md`.
- Run `npm run dev:api`, open `/api/meta` and `/api/rca?day=2026-10-13&step=offer_viewed` to confirm.
- **Done when:** tests green, API responds, notes written.

### S1. What-if simulator
**Files:** `server/src/analytics/simulate.js`, route `POST /api/simulate` in `analytics/routes.js`, `server/test/simulate.test.js`.
**Spec:**
- Input: `{ candidate: <ruleset config> | { base: "v2", overrides: {...} }, baseline: "v2" (default current), from, to }`. Validate with `validateRuleset`.
- Population: applications that completed KYC in the window (they would reach eligibility and a bureau pull). Score = `bureau_score_latent`.
- For each application evaluate prescreen then credit under baseline and candidate with `evaluate`. Output for each: approve/refer/reject counts and rates, top reason codes, and by-segment tables (device, channel, employment, new_to_credit).
- **Expected disbursals** = sum over approved of `P(accept | rate band, amount cut)` x `0.93`, where acceptance by rate band is estimated empirically from the stored data (not hard-coded).
- **Expected NPA** = sum(default_prob x offered_amount over expected-disbursed) / sum(offered_amount over expected-disbursed). Also report approved-but-would-default counts.
- Response must include `notice`: default probabilities are a synthetic ground truth that real lenders do not observe for rejected applicants; no behavioural reaction to the new policy is modelled.
- **Tests:** identical ruleset gives zero deltas; tightening FOIR cap lowers approvals and NPA; loosening score cutoff raises approvals and NPA; invalid ruleset returns 400.
- **Done when:** the three behaviours above hold and are tested.

### S2. RAG over the RBI Digital Lending Directions
**Files:** `server/src/rag/ingest.js`, `search.js`, `answer.js`, route `POST /api/compliance/ask`, `GET /api/compliance/sources`, `server/test/rag.test.js`, `server/test/rag_eval.json`.
**Spec:**
- Source: `data/rbi/rbi_digital_lending_directions_2025.pdf` (RBI/2025-26/36, 8 May 2025). Extract with `pdftotext -layout` (if unavailable on the machine, use the npm `pdf-parse` package and document it).
- Clean: drop the "Withdrawn" watermark lines (lines of 1 to 3 letters only), bare page numbers, repeated footers.
- Chunk by clause using heading pattern `^\s{2,8}(\d{1,2})\.\s+Title`, and split sub-paragraphs on roman numerals (i), (ii) and (a), (b). Store in `rag_chunks` with `doc_id, doc_title, chapter, clause, para, heading, content`.
- Retrieval: Postgres `websearch_to_tsquery` over the generated `tsv` column, ranked with `ts_rank_cd`. Return top 5.
- Answer: **extractive** (quote the best chunks, no invention) with citations `Clause N, para (x)`. If the best rank is below a tuned threshold return "Not found in the Directions" and suggest rephrasing.
- **Mandatory notice on every answer:** source is the RBI Digital Lending Directions, 2025 (RBI/2025-26/36, 8 May 2025); the PDF is stamped **Withdrawn**, so verify the currently applicable instruction before relying on it; this is not legal advice.
- If `LLM_PROVIDER=anthropic` and a key is set, an LLM may rewrite the extractive answer more fluently **using only the retrieved text**, and must keep the citations. Default is no LLM.
- **Eval set:** write 20 questions with the expected clause (for example KFS content, cooling-off, APR disclosure, data collection and consent, grievance redressal, DLA reporting, fees via the RE). Test reports hit@1 and hit@3 and lists the misses. Print real numbers in `docs/RAG_EVAL.md`; do not tune the questions to the answers after seeing results without noting it.
- **Done when:** ingestion is idempotent, eval runs in `npm test`, README quotes the measured hit rates.

### S3. A/B experiment framework
**Files:** `server/src/experiments/assign.js`, `analyse.js`, `brief.js`, `simulateExperiment.js`, routes under `/api/experiments`, `server/test/experiments.test.js`. Uses the `experiments` table.
**Spec:**
- Definition: `key, name, hypothesis, primary_metric, guardrails[], variants[{name, weight}], status`.
- Assignment: deterministic `hash(applicationId + key) mod 100` against variant weights. Same input always gives the same variant.
- Because the main dataset must stay clean for the RCA demo, run experiments on a **separate simulated cohort** generated on demand with a seeded, known true effect (for example "show the KFS summary above the Accept button": +2 points acceptance). Store results with `variant` set; label as synthetic.
- Analysis: two-proportion z-test and confidence interval for the primary metric; **SRM check** (chi-square on assignment counts); guardrails (default rate on disbursed, median TAT, complaint proxy) each with a tolerance; decision rule: ship only if primary is significant and no guardrail breaches, else hold or stop.
- Brief: auto-drafted markdown (hypothesis, results table, guardrail table, decision, caveats). Template-based; LLM optional.
- **Tests:** assignment stability and balance; no-effect experiment gives "hold"; real effect gives "ship"; guardrail breach blocks ship; SRM is flagged on a skewed split.

### S4. Mock controls (incident injection)
**Files:** extend `mock/routes.js` and `/api/mock` helpers; add `scripts/live-load.js`.
- Expose bureau/KYC controls (latency multiplier, error rate, timeout rate, forced score) via the existing `/mock/config`.
- `scripts/live-load.js`: sends N journeys through the real API so the PM can inject a bureau slowdown live and see new `api_calls` rows.
- **Done when:** a live-injected slowdown changes recorded latency and the fallback path produces `BUREAU_UNAVAILABLE` referrals (test it).

### S5. React workbench UI
**Files:** `web/` (Vite React app), served by Express from `web/dist` in production; dev proxy to port 4000.
**Pages:**
1. **Journey:** a form to apply, KYC, eligibility, offer (shows the KFS and reason codes), accept.
2. **Workbench** tabs:
   - **Funnel:** daily funnel chart, step conversion lines, segment breakdown, release/rule markers on the timeline.
   - **Anomalies:** list from `/api/anomalies`; clicking one opens its RCA.
   - **RCA:** drop decomposition, ranked hypotheses with score bars, evidence, hourly latency timeline, narrative, caveat text.
   - **Simulator:** edit thresholds (score cutoffs, FOIR caps), run, show conversion vs NPA side by side, by-segment table.
   - **Compliance:** ask box, answer with citations and the withdrawn-source notice.
   - **Experiments:** definitions, results, guardrails, brief.
   - **Mock controls:** sliders/toggles for bureau and KYC behaviour.
- Global banner: "Synthetic data. Not a real lending system."
- Design: clean, dense, readable; light and dark; charts via Recharts; no external CDNs required.
- **Done when:** a screen recording path works end to end: pick the 13 Oct anomaly, see the bureau slowdown ranked first, simulate a rule change, ask a compliance question.

### S6. Optional LLM provider switch
**Files:** `server/src/llm/index.js`.
- Interface `summarise(evidence, instruction)`; providers `none` (templates) and `anthropic` (needs `ANTHROPIC_API_KEY`). Strict prompt: use only provided evidence, keep numbers unchanged, keep citations. Validate that numbers in the output match the input; otherwise fall back to the template.
- Used by RCA narrative, experiment brief, and compliance rewrite only.

### S7. Documentation
- `README.md`: what it is, screenshots (owner will add), quick start (`npm install`, `npm run dev`), architecture diagram, API list, test results, **honest limitations**.
- `docs/PRD.md`: problem, users, goals and non-goals, user stories, success metrics, risks.
- `docs/METRIC_TREE.md`: north star (disbursal conversion) down to step metrics, plus guardrails (NPA, TAT, complaints).
- `docs/DEMO_SCRIPT.md`: a 5-minute walkthrough, one story per tab.
- `docs/INTERVIEW_QA.md`: about 30 questions with short answers grounded in this code (why deterministic rules, how the detector works and its false-positive rate, how RCA avoids false causes, why extractive RAG, what synthetic data can and cannot show, what you would do with real data).
- `docs/RAG_EVAL.md`, `docs/PROGRESS.md`.

### S8. Hardening
- Ensure `npm test` is green from a clean checkout; add a `npm run check` that runs tests and builds the web app.
- Validate all API inputs; consistent error JSON; no stack traces to clients.
- Verify the run on Windows (paths, embedded Postgres) and document fixes.
- Optional: `docker-compose.yml` runs the app with an external Postgres.

### S9. Claims audit and resume
- Produce `docs/CLAIMS_AUDIT.md`: a table of every claim made in README/resume, the code or test that proves it, and status (built/partial/not built).
- Update the LoanLens resume bullets to match only what is built. Do **not** mention Rate Limiter or TaskForge inside LoanLens. Keep the stack line accurate (drop Redis unless it is actually used).

---

## 6. Kick-off prompt to give Claude Code

> Read `docs/LOANLENS_BUILD_SPEC.md` fully. Follow its ground rules (no git, synthetic-data labelling, no Rate Limiter/TaskForge claims, LLM never decides credit). Start at S0 and proceed step by step through S9. After each step run `npm test`, update `docs/PROGRESS.md`, and if a test fails, find and fix the root cause rather than weakening the test; report only if you are genuinely blocked by something outside the code. Do not rewrite existing modules unless a bug blocks you; extend them.

## 7. How to talk about it in an interview (30 seconds)

"LoanLens is a PM workbench for a digital-lending funnel. When conversion drops it detects the anomaly, ranks root causes by joining funnel events with bureau and KYC API latency, releases and rule changes, lets me simulate a policy change and see conversion and expected NPA together, checks the change against RBI's Digital Lending Directions with citations, and runs the A/B test with guardrails. The rules engine, not an LLM, makes every credit decision. It runs on synthetic data, and I can show where the detector is wrong too."

---

## 8. Real data to collect (calibration and sources)

**Principle.** Row-level funnel data from a real lender is confidential and not publicly available. LoanLens therefore stays on synthetic applications, but the generator, rules and pricing are **calibrated** from public data, and the compliance RAG uses real documents. Every number taken from a public source must be logged with its provenance. Never blend real and synthetic rows silently.

### 8.1 Dataset types needed

| # | Dataset type | What it contains | Used for | Format to save | India or global? |
|---|---|---|---|---|---|
| 1 | Loan-level credit risk with outcome | Income, loan amount, term, rate, credit grade or score, debt-to-income, employment, default / charged-off flag | Fit the default-probability model used by the simulator (replaces the hand-set formula in `generate.js`) | CSV (one row per loan) | **Global acceptable**, India preferred if it exists. Label as "non-Indian calibration" |
| 2 | Funnel conversion benchmarks | Step-wise conversion (apply, KYC, approval, offer accepted, disbursed), approval rates, drop-off reasons, turnaround time | Calibrate the seeded step rates and TAT in `generate.js` | Small table or JSON of ranges with source and date (not row-level) | **India preferred** (digital lending behaves differently by market); global only as a fallback, flagged |
| 3 | Pricing and policy facts | Interest-rate bands by score, processing-fee ranges, typical FOIR caps, minimum income and age rules, tenure ranges | Validate `defaultRules.js` pricing and thresholds | JSON of ranges with source | **India required** (rules must reflect Indian lenders) |
| 4 | Portfolio and asset-quality statistics | Gross NPA / delinquency for unsecured personal loans, sector trends | Sanity-check simulated NPA range | Table of figures with source and date | **India required** for headline numbers; global for context only |
| 5 | Regulatory documents | RBI Digital Lending Directions and the instruments that replaced or complement them (KFS, Fair Practices, KYC, outsourcing, grievance) | RAG corpus (S2) | PDF, plus extracted text | **India required**, official RBI sources only |
| 6 | Provider API behaviour | Request/response shapes, documented SLAs, error codes for bureau, eKYC, DigiLocker, CKYC, account aggregator | Make `/mock` bureau and KYC responses realistic | Short notes plus sample JSON copied from public docs | **India preferred** (the integrations differ); global bureau docs acceptable for shape |
| 7 | Incident postmortems | Public outage / regression write-ups with timeline, impact on conversion or transactions | Realistic incident shapes for the seeded scenarios; interview stories | Notes with link and one-paragraph summary | **Global fine** (patterns transfer) |
| 8 | PM reference material | Metric trees, guardrail practice, experimentation guidance | PRD, metric tree, experiment design | Notes with links | **Global fine** |

### 8.2 India vs global: the rule to follow
- **Must be India:** regulatory text (#5), pricing and policy facts (#3), asset-quality headline figures (#4).
- **India preferred, global acceptable with a label:** funnel benchmarks (#2), provider API behaviour (#6), loan-level risk data (#1, because public Indian loan-level data with outcomes is scarce).
- **Global is fine:** incident postmortems (#7), PM references (#8).
- Whenever global data is used where India is preferred, the README must say so in one line, for example: "Default behaviour is calibrated on a non-Indian public loan dataset; absolute levels are illustrative."

### 8.3 Provenance log (required)
Create `data/sources/SOURCES.md` with one row per source: title, publisher, link, retrieval date, licence or terms, region (India/global), what was extracted, and which file or constant in the code it informs. Check each dataset's licence before including it in the repo; if redistribution is not allowed, store only the extracted figures and link to the source instead of committing the raw file.

### 8.4 Search keywords per dataset type
1. **Loan-level risk:** "Lending Club loan data Kaggle", "Give Me Some Credit dataset", "Home Credit Default Risk Kaggle", "German credit dataset UCI", "credit risk dataset personal loan default", "Indian loan default dataset", "NBFC loan dataset India".
2. **Funnel benchmarks:** "digital lending funnel conversion rate benchmark India", "loan application drop-off rate KYC", "personal loan approval rate fintech India", "loan origination funnel benchmarks", plus listed lenders' annual reports and investor presentations (for example Bajaj Finance, IDFC First Bank).
3. **Pricing and policy:** "personal loan interest rate range India by credit score", "FOIR limit personal loan India", "processing fee personal loan India", "minimum income eligibility personal loan India", "CIBIL score bands lending decision".
4. **Asset quality:** "RBI Financial Stability Report gross NPA unsecured personal loans", "RBI unsecured retail loans growth risk weights", "RBI Report on Trend and Progress of Banking".
5. **Regulatory:** "RBI Digital Lending Directions 2025 withdrawn superseded", "RBI Master Direction digital lending latest", "RBI Key Fact Statement guidelines", "RBI Fair Practices Code", "RBI KYC Master Direction", "RBI outsourcing of financial services directions", "RBI grievance redressal ombudsman", "RBI digital lending apps directory DLA".
6. **API behaviour:** "credit bureau API documentation CIBIL TransUnion Experian CRIF", "Aadhaar eKYC API response", "DigiLocker API documentation", "CKYC API", "account aggregator API India", "Karza Signzy IDfy Setu Perfios API docs".
7. **Postmortems:** "postmortem payment API outage conversion drop", "KYC provider outage fintech postmortem", "mobile app release regression funnel drop case study", "credit bureau outage".
8. **PM references:** "lending product metrics NPA TAT approval rate", "lending metric tree", "A/B testing guardrail metrics", "champion challenger credit policy", "sample ratio mismatch".

### 8.5 Build step S10: calibration (after S9)
- Add `data/calibration.json` holding the extracted ranges (with source ids from `SOURCES.md`).
- Make `generate.js` read its step rates, TAT and pricing bands from `calibration.json` instead of constants, defaulting to current values.
- If a loan-level dataset (#1) is used: add `scripts/fit_default_model.js` that fits a simple logistic regression (score, debt-to-income, employment) and writes the coefficients to `calibration.json`; the generator uses them for `default_prob`. Report the fit quality (AUC on a held-out split) in `docs/CALIBRATION.md`, and state clearly that it is trained on non-Indian data if so.
- Re-run all tests; the seeded incident tests must still pass (re-check detector false alarms and report the new numbers; do not tune to hide them).
- Never claim the funnel itself is real. Claim only "parameters calibrated from public sources (listed in SOURCES.md)".
