# LoanLens claims audit

> **Synthetic data.** Everything LoanLens measures is on generated data. This file lists each claim made in the README, the docs and the resume bullets, what proves it, and whether it is actually built. Nothing in the resume text may go beyond the "Built" rows.

**Status key**
- **Built, tested**: a test in the suite fails if the claim stops being true.
- **Built, measured once**: true when measured, quoted with its date or conditions, but no test pins the number.
- **Partial**: some of the claim is built, or it was checked by hand only. The gap is stated.
- **Not built / not verified**: do not claim it.

Evidence paths are relative to the repository root. Suite at the time of writing: server and web tests passing under `npm test` (counts in `docs/PROGRESS.md`).

## 1. Product claims

| # | Claim | Evidence | Status |
|---|---|---|---|
| 1 | Credit decisions (approve, refer, reject) come only from a deterministic rules engine, with reason codes | `server/src/rules/engine.js`; `server/test/rules.test.js` (8), `journey.test.js` | Built, tested |
| 2 | A language model never makes or influences a credit decision | `server/test/llm.test.js`: the module is not imported by `rules/`, `journey/`, `integrations/`, `data/`, `mock/`, and only three phrasing hooks use it | Built, tested (structural) |
| 3 | Rulesets are versioned data (v1 FOIR 55%, v2 50% from 29 Sep) and a new version needs no redeploy | `rules/defaultRules.js`, `POST /api/rules`; `journey.test.js` "a new rule version…", `hardening.test.js` (validation, duplicate) | Built, tested |
| 4 | Working journey: start, KYC, eligibility, offer with Key Fact Statement shown before accept, accept | `journey/service.js`, `rules/kfs.js`; `journey.test.js` happy path; `web/test/app.test.jsx` journey walk | Built, tested |
| 5 | The APR in the KFS follows RBI's prescribed method | `rules/kfs.js` says the method is illustrative | **Not built**: say "illustrative APR" only |
| 6 | Provider calls time out, retry once and fall back to a manual-review referral (`BUREAU_UNAVAILABLE`) instead of failing or approving | `integrations/providerClient.js`; `journey.test.js` "bureau outage…", `mock_controls.test.js` live-injection test | Built, tested |
| 7 | Mock providers honour idempotency keys | `server/src/mock/routes.js` (cache keyed on `Idempotency-Key`) | Built, **no test** |
| 8 | Mock providers sit behind a small in-process token-bucket limiter | `server/src/mock/rateLimit.js` | Built, no dedicated test. It is a stand-in, **not** the Rate Limiter project |
| 9 | Synthetic dataset: 40 days from 10 Sep 2026, about 27,000 applications, four planted stories, flagged `is_synthetic` and labelled in the UI and API | `data/generate.js`, `data/seed.js`; `analytics.test.js` (shape, all synthetic); `web/test/app.test.jsx` banner; `/api/meta` notice | Built, tested |
| 10 | The generator knows who would default, which a real lender never does | `generate.js` comment and `default_prob` column; stated in README and simulator notice | Built (documented) |

## 2. Analytics claims

| # | Claim | Evidence | Status |
|---|---|---|---|
| 11 | Daily step-conversion anomaly detector: 14-day median baseline, robust spread floored by binomial error, flag at z ≤ -3 and a drop of at least 3 points | `analytics/anomaly.js` (`DETECTOR`); `analytics.test.js` "detector flags the seeded incidents", "stays quiet on normal days" | Built, tested |
| 12 | On the seeded data the daily detector flags exactly 6 day-steps: 5 planted (29 Sep, 6, 7, 8, 13 Oct) and 1 with no cause of its own (5 Oct, six days after the policy change, so possibly partly the same effect) | `analytics.test.js` "measured detector behaviour…" pins the list | Built, tested |
| 13 | This is a false-alarm **rate** | Over 8 re-rolled draws (`scripts/evaluate-detector.mjs`) there were 0 daily flags outside the policy-change window, but that is 8 draws of 40 days, not a rate with an error bar | **Do not claim a rate**: say "one flag with no cause of its own in the shipped data; none outside the policy window in 8 re-rolled draws" |
| 14 | RCA ranks hypotheses by counterfactual share of the drop explained (provider latency dose-response, release difference-in-differences, policy replay, traffic mix) | `analytics/rca.js`; `analytics.test.js` RCA tests | Built, tested |
| 15 | On 13 Oct the bureau slowdown ranks first and the same-morning iOS release is ruled out | `analytics.test.js` "RCA ranks the bureau slowdown first…" | Built, tested |
| 16 | On 7 Oct the Android 2.3 release (not the KYC API) explains the KYC drop | `analytics.test.js` (score > 0.5, API ruled out). The "100%" quoted in the docs is from a manual run | Built, tested; exact score measured once |
| 17 | 29 Sep drop is attributed to the FOIR policy change | `analytics.test.js` "RCA attributes the 29-30 Sep dip…". The "71%" in the Q&A is from a manual run | Built, tested; exact score measured once |
| 18 | Known RCA artefact: within about 14 days after a policy change a small "possible" policy score can appear (19% on 5 Oct) | `analytics.test.js` "known RCA artefact…" (score between 0.15 and 0.30, never "likely") | Built, tested (documented limitation) |
| 19 | RCA scores are not probabilities and are not proof of causation | Caveat text in the API response and UI; `web/test/app.test.jsx` checks it is shown | Built, tested |
| 20 | RCA has a provider hypothesis only for the KYC and offer steps | `rca.js` `apiHypothesis` | Built (stated as a limit) |
| 21 | Analytics loader went from about 56 s to 0.84 s on the full dataset with identical output | S5 notes in `docs/PROGRESS.md` (compared old and new row by row on three windows) | Built, measured once on one machine |
| 22 | What-if simulator replays stored applicants through baseline and candidate rulesets and shows approvals, expected disbursals and expected NPA together, with a notice that default risk is synthetic and behaviour is not modelled | `analytics/simulate.js`; `simulate.test.js` (11) | Built, tested |
| 23 | Acceptance probability is estimated from stored offers, not hard-coded | `simulate.test.js` "acceptance model is estimated…" | Built, tested |
| 24 | Example: FOIR 0.50→0.45 and soft cap 0.40→0.38 cut approve rate 2.1 points and expected NPA 1.42%→1.37% | S1 notes (one run on the full data) | Built, measured once. Tests assert direction only |
| 25 | Simulated NPA is realistic or calibrated | Default risk is a hand-set formula | **Not built, by decision**: the project stays on its synthetic dataset; do not call the NPA level realistic |
| 26 | Overall disbursal conversion 18.6%; step rates 81.8%, 86.2%, 48.8%, 58.1%, 93.3% | Read from `/api/funnel` in S7; `analytics.test.js` only checks the steps are nested | Built, measured once |

## 3. Compliance (RAG) claims

| # | Claim | Evidence | Status |
|---|---|---|---|
| 27 | The RBI Directions PDF is chunked into 99 clause and paragraph chunks, re-ingestion is idempotent | `rag/ingest.js`; `rag.test.js` (30 clauses and 3 annexes, idempotent) | Built, tested |
| 28 | Answers are extractive: verbatim stored text with `Clause N, para (x)` citations | `rag/answer.js`; `rag.test.js` | Built, tested |
| 29 | Every answer, including "Not found", carries the notice that the PDF is stamped Withdrawn and this is not legal advice | `answer.js` `NOTICE`; `rag.test.js`; `web/test/app.test.jsx` | Built, tested |
| 30 | Out-of-scope questions are refused: 6 of 6 | `rag.test.js` eval; `docs/RAG_EVAL.md` | Built, tested (the test enforces a floor of 80%; the 6/6 is the measured result in `RAG_EVAL_RESULTS.json`) |
| 31 | Clause hit@1 85% and hit@3 90% on 20 questions (BM25), versus 55% and 85% for the first baseline | `rag.test.js` eval, `docs/RAG_EVAL.md`, regenerated `docs/RAG_EVAL_RESULTS.json` | Built, measured. The test enforces floors (hit@3 ≥ 80%, hit@1 ≥ 70%), not the exact figures | A second, held-out set of 20 questions (never used for tuning) gives 85% / 90% again, and refusal of 4 of 6 unrelated questions.
| 32 | These are accuracy figures | The ranker and threshold were chosen after seeing this set; 20 questions; thin margin (0.341 vs 0.361) | **Partial**: quote only as "regression guard, optimistic, tuned on the same set" |
| 33 | It answers compliance questions in general | One document, lexical search, misses abbreviations (DLG) | **Partial**: "retrieval aid over one document" |

## 4. Experimentation claims

| # | Claim | Evidence | Status |
|---|---|---|---|
| 34 | Deterministic hash assignment, balanced, independent across experiments | `experiments/assign.js`; `experiments.test.js` | Built, tested |
| 35 | Two-proportion z-test with 95% interval, chi-square sample-ratio check, guardrails with ok/uncertain/breach, fixed ship/hold/stop rule | `experiments/analyse.js`; `experiments.test.js` (18) | Built, tested |
| 36 | A true +2 point effect ships 30/30, no effect ships 1/30, interval covers the truth 29/30 (40,000 units, 30 seeds) | `experiments.test.js` | Built, tested |
| 37 | A 60-seed check: 57/60 ships, 3/60 stops on a fluke | One-off script, not in the suite | Built, measured once |
| 38 | Experiments run on real traffic | Cohorts are generated with a known effect; complaint metric is a proxy; single look, no sequential testing | **Not built**; "framework demonstrated on simulated cohorts" |
| 39 | Auto-drafted decision brief | `experiments/brief.js`; `experiments.test.js` | Built, tested |

## 5. Platform claims

| # | Claim | Evidence | Status |
|---|---|---|---|
| 40 | Incident injection (scenarios, validated sliders, status view) and a load script | `mock/controls.js`, `scripts/live-load.js`; `mock_controls.test.js` (6) | Built, tested |
| 41 | React workbench with Journey, Funnel, Anomalies, RCA, Simulator, Compliance, Experiments, Mock controls, light/dark | `web/src/pages/*`; `web/test/app.test.jsx` (17) covers shell, RCA, Compliance, Journey, markdown | **Partial**: Funnel, Anomalies, Simulator, Experiments and Mock controls pages have no component test; charts, dark theme and the 375 px layout were checked by hand once |
| 42 | Optional LLM switch (`none` default, `anthropic`) that only rewords and validates numbers against the evidence | `llm/index.js`; `llm.test.js` with a fake HTTP client | Built, tested against a fake. **The real Anthropic API has never been called.** Do not say it works with Claude |
| 43 | One JSON error contract, no stack traces to clients, input validation on the routes | `app.js` `errorHandler`, `http/validate.js`; `hardening.test.js` (12) | Built, tested |
| 44 | `npm run check` (tests and build) passes from a clean checkout | A copy without `node_modules` or `.data` passed `npm install` and `npm run check` in S8 | Built, measured once (Windows 11, Node 24) |
| 45 | Runs on Windows | Developed and tested on Windows 11 only; three Windows bugs found and fixed (`db/connection.js`) | Built for Windows. **macOS and Linux not verified** |
| 46 | Runtime dependencies have no known vulnerabilities | `npm audit --omit=dev` found 0 after S8; 6 remain in dev tooling | Built, measured once; re-run `npm audit` before quoting |
| 47 | Optional `docker-compose.yml` with PostgreSQL | File exists (Redis removed in S9); never run | **Not verified** |
| 48 | Authentication, authorisation, rate limiting on the real API | None | **Not built** (stated in README) |
| 49 | A sustained-shift detector finds the lasting policy change the daily detector often misses (7 of 8 re-rolled draws, versus 2 of 8) with 0 unexplained episodes | `analytics/anomaly.js` `detectShifts`; `analytics.test.js` (synthetic drop, quiet series, shipped data); `scripts/evaluate-detector.mjs` | Built, tested; the 7-of-8 is measured, with settings **chosen on those same 8 draws** (optimistic) |
| 50 | The RCA does not score causes for a day that is within normal variation | `rca.js` significance gate; `analytics.test.js` "RCA does not score causes…" | Built, tested |
| 51 | The RCA ranks the true cause first on the Android and bureau days across re-rolled draws | `scripts/evaluate-detector.mjs` (see `docs/IMPROVEMENT_LOOPS.md`) | Built, measured once (32 of 32 incident days over 8 draws); a shared shock hitting one platform harder by chance can still mislead the release check |
| 52 | Held-out retrieval: hit@1 85%, hit@3 90%; refusal 4 of 6 | `server/test/rag_heldout.json`, `rag.test.js` (floors), `docs/RAG_EVAL.md` | Built, tested; refusal is the weak spot and is not fixed |
| 53 | The language-model output must be grounded: no gained minus sign, no more than 1,500 characters, at least 60% of content words in the evidence | `llm/index.js`; `llm.test.js` | Built, tested against a fake client only. A reversed direction word is **not** caught |
| 54 | Experiment analysis reports the minimum detectable effect, and the decision rule behaves as measured over 150 repeats (null: 1.3% ship, 4.0% stop; +2 pts: 97% ship) | `experiments/analyse.js`; `experiments.test.js` (formula); `scripts/evaluate-experiments.mjs` | Built, tested (formula); rates measured once |
| 55 | Parallel requests for one application cannot create duplicate events or bureau calls | `journey/service.js` `withApplication`; `journey.test.js` | Built, tested; **one process only** |
| 56 | The application API does not expose the synthetic ground truth; hardening headers on every response; a missing asset is a 404 | `journey/routes.js`, `app.js`; `hardening.test.js` | Built, tested |
| 57 | Analytics results are cached and never stale; a repeat is about 0.1 s | `analytics/data.js`; `hardening.test.js`; harness timings | Built, tested; timings measured once on one machine |
| 58 | The simulator reports a backtest against actual disbursals (expected 4,150 vs 5,011 actual, ratio 0.83; 699 of the actual followed a manual review) | `analytics/simulate.js`; `simulate.test.js` (band only) | Built, tested (band); the figures are measured once. The simulator **under-predicts** by about 17% |
| 59 | The UI is responsive: no horizontal overflow and no text under 4.5:1 contrast on all pages, light and dark, from 320 to 1440 px; first-load script 161 kB (was 608 kB) | `web/src/styles.css`, `App.jsx`; checked by script in the browser pane (`docs/IMPROVEMENT_LOOPS.md`) | Built, measured once. **Not tested on a real phone, other browsers or a screen reader**; no automated layout test (jsdom has no layout) |
| 60 | A repeatable evaluation harness (170 checks) and multi-seed scripts | `scripts/evaluate.mjs`, `evaluate-detector.mjs`, `evaluate-experiments.mjs` | Built; run by hand, not part of `npm test` |

## 6. Claims that must not be made

- That Rate Limiter or TaskForge is integrated, used or part of LoanLens. They are separate projects. LoanLens has only the small stand-in limiter in front of its mock providers.
- Redis, BullMQ, Kafka or Docker as part of the stack. The app uses PostgreSQL (embedded or external) and nothing else for state.
- Machine-learning credit scoring, calibrated default or NPA, real lender data, real bureau or KYC integrations, production use, or "RBI-compliant".
- A measured false-positive rate for the detector, a retrieval accuracy that is not caveated as tuned on the same set, or a business outcome (conversion uplift, cost saved) of any kind.
- That the LLM path works against a real API.
- Embeddings or vector search. Retrieval is PostgreSQL full-text search plus BM25.

## 7. Resume text (matches only the "Built" rows)

**Stack line:** Node.js (Express, ESM), PostgreSQL (full-text search), React, Vite, Recharts, `node:test`, Vitest. Optional Anthropic API switch (off by default).

**Project title:** LoanLens, a product-manager workbench for a digital-lending funnel (synthetic data, portfolio project)

**Bullets**
- Built an end-to-end digital personal-loan prototype: a versioned, deterministic rules engine (approve, refer, reject with reason codes), mock bureau and KYC providers with injectable latency and failures, and a journey that shows a Key Fact Statement before acceptance and falls back to manual review when the bureau times out. [claims 1, 3, 4, 6]
- Designed a detect-diagnose loop on a generated 27,000-application funnel with four planted incidents: an anomaly detector (14-day median baseline, z ≤ -3 plus a 3-point minimum drop) and a root-cause ranking that scores provider latency, releases, policy changes and traffic mix by counterfactual share of the drop explained. It ranks the planted bureau slowdown first and rules out a decoy release; the daily detector flagged all five planted incident days plus one flag with no cause of its own, reported openly. Re-rolling the generator showed it misses a lasting policy change in most draws, so I added a sustained-shift detector and measured both across 8 seeds (settings chosen on those seeds). [claims 11, 12, 14, 15, 18, 49]
- Built a what-if simulator that replays stored applications through a candidate ruleset and reports approvals, expected disbursals and expected NPA side by side, with an explicit caveat that default risk is a synthetic ground truth. [claims 22, 23]
- Built a cited question-answering tool over the RBI Digital Lending Directions: PostgreSQL full-text search with BM25 re-ranking, extractive answers with clause citations, a refusal threshold and a standing "source is stamped Withdrawn" notice. On 20 labelled questions the right clause was first for 85% and in the top three for 90% (ranker tuned on the same set, so treat as a regression guard). [claims 27 to 32]
- Built an A/B experiment framework with deterministic assignment, a sample-ratio check, guardrails and a ship/hold/stop rule; on simulated cohorts a true +2 point effect shipped 30 of 30 times and a null effect 1 of 30. [claims 34 to 36]
- Kept the LLM out of decisions by design: an optional provider switch only rewords summaries, rejects any output containing numbers not in the evidence, and is structurally unreachable from the rules engine (tested). [claims 2, 42]
- Wrote 130+ automated tests (server and web) and a repeatable 170-check evaluation harness; ran eight evaluate-and-fix loops that found and fixed a request race, an API leaking synthetic ground truth, over-confident RCA scores on quiet days and a language-model check that a digit-free invented claim could pass; made the UI responsive from 320 to 1440 px. [claims 43, 50, 53, 55, 56, 59, 60]

**One-line version:** Built LoanLens, a synthetic-data PM workbench that detects funnel drops, ranks root causes, simulates rule changes against expected NPA, answers RBI-directions questions with citations, and runs guarded A/B experiments, with a deterministic rules engine making every credit decision.

**If asked:** it is a portfolio prototype on synthetic data; the real LLM path is untested; the detector had one false alarm; the retrieval figures are tuned on their own test set.
