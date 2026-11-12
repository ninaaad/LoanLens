# LoanLens build progress

All data in LoanLens is synthetic. Notes are appended per step.

## S0. Orientation (done)

**Environment:** Windows 11, Node v24.14.0, npm 11.9.0, embedded Postgres 18.4 (no external DB or Docker needed).

**Results**
- `npm install`: OK, 0 vulnerabilities.
- `npm test`: **21/21 passing** (rules 8, journey 6, analytics 7), about 136 s. Most of that is seeding the ~27k-application dataset twice-over (seed alone ~70 s on this machine; the funnel test spent ~60 s in its own query).
- `npm run dev:api`: starts, seeds an empty DB (26,879 applications, 102,371 events, 46,083 API calls), serves on port 4000.
- `/api/meta` responds; `/api/rca?day=2026-10-13&step=offer_viewed` ranks the **bureau API slowdown first (score 1)**, as designed.

**Two Windows bugs found and fixed (both in `server/src/db/connection.js`)**
1. `initdb` on Windows defaulted the database to `WIN1252`, so inserting the rupee sign in rule JSON failed (`22P05`) and every journey test crashed in `ensureDefaultRules`. Fix: pass `initdbFlags: ['--encoding=UTF8', '--locale=C']`.
2. Test teardown failed with `EPERM` when deleting the temporary Postgres data dir (Postgres briefly keeps files locked after `stop()`), which marked `analytics.test.js` as failed even though its 7 tests passed, and could hang the run. Fix: `rmSync` with retries, and a leftover temp dir no longer fails the run.

**Known gaps / observations (not fixed, not blocking)**
- The first-ever `npm run dev:api` on a fresh `.data/pg` exited with an uncaught `undefined` exception right after initialising the data dir; a second start worked. Not reproduced since; if it recurs, delete `.data/` and retry.
- The funnel test's query takes ~60 s on this machine. A performance look at `analytics/funnel.js` / `data.js` is worth doing before the UI (S5) depends on it.
- The root `npm run dev` also starts the `web` workspace, which is built in S5.
- Tests leave nothing running, but unrelated Postgres processes already on the machine (Services session) were not touched.

**Third Windows fix found during S1 (also `server/src/db/connection.js`):** after `server.stop()` the embedded Postgres child's stdio pipes stayed open (orphaned workers on Windows), so Node never exited and a test file could hang until killed (3 of 3 concurrent runs hung before the fix, 0 of 3 after; the full `npm test` hung once before it). `close()` now destroys those pipes and unrefs the child.

## S1. What-if simulator (done)

**Built**
- `server/src/analytics/simulate.js`, route `POST /api/simulate` (in `analytics/routes.js`), `server/test/simulate.test.js`.
- Input: `{ candidate, baseline?, from?, to? }`. `candidate`/`baseline` may be a version name (`"v1"`), a full ruleset config, or `{ base: "v2", overrides: { rules: { <ruleId>: { value | op | onFail } }, pricing, maxLoanIncomeMultiple } }`. Everything goes through `validateRuleset` plus checks for non-finite values and bad pricing; every bad input returns 400 with a message. Baseline defaults to the latest stored version; window defaults to the full data range (IST days, inclusive).
- Population: applications that completed KYC in the window. Each is run through prescreen then credit under both rulesets by the existing `evaluate` (rules engine untouched), scored on `bureau_score_latent`.
- Output per side: approve/refer/reject counts and rates, top reason codes, expected disbursals, expected disbursed amount, expected NPA, approved-but-would-default count; plus deltas, a baseline-to-candidate decision-flow matrix, by-segment tables (device, channel, employment, new_to_credit) and the acceptance table used.
- Expected disbursals = sum over approved of P(accept) x 0.93. P(accept) is estimated from stored data (share of shown offers accepted, by offered rate and whether the amount was cut; cells under 30 offers, or rates never offered, borrow the nearest observed rate). Expected NPA = sum(default_prob x amount x p) / sum(amount x p) over expected disbursals.
- Every response has `synthetic: true` and the required `notice` (synthetic ground truth for default; no behavioural reaction modelled). Referred applications are not counted as disbursals; this is stated in `caveats`.

**Tests:** `simulate.test.js` 10 tests (identical ruleset gives zero deltas; tightening FOIR lowers approvals, disbursals and NPA; loosening score cut-offs raises approvals and NPA; counts add up and segments partition the population; v1 vs v2; acceptance model comes from data; window filter; 15 invalid-input cases return 400; no writes). It seeds its own smaller dataset (150/day) so it runs in about 23 s.

**Full suite: 31/31 passing** (rules 8, journey 6, analytics 7, simulate 10), about 135 s. `npm run dev:api` starts and `POST /api/simulate` answers on the full seeded dataset.

**Example measured run (full dataset, 21,995 KYC-complete applications, baseline v2):** tightening `foir_hard` 0.50 to 0.45 and `foir_soft` 0.40 to 0.38 moved approvals 7,469 to 7,001 (-2.1 pts approve rate), expected disbursals 4,150 to 3,890, expected NPA 1.42% to 1.37% (-0.05 pts), approved-would-default 115 to 99. The NPA gain is small next to the lost volume; that is what the synthetic default model gives, not a general finding.

**Known gaps**
- The NPA level (about 1.4%) comes from the hand-set default formula in `generate.js`; it is not calibrated until S10.
- Applying the latent score ignores bureau outages, so incident-day applicants are scored as if the bureau had answered.
- Tests assert direction (more or fewer approvals, higher or lower NPA), not exact magnitudes, on purpose.

## S2. RAG over the RBI Digital Lending Directions (done)

**Built**
- `server/src/rag/ingest.js` (`pdftotext -layout`, falling back to the npm `pdf-parse@1.1.1`, which I installed; both give the identical 99 chunk keys), `search.js`, `answer.js`, `evaluate.js`, `routes.js`; `POST /api/compliance/ask`, `GET /api/compliance/sources` (mounted in `app.js`); `npm run ingest`; the server also ingests on start-up when `rag_chunks` is empty.
- Cleaning handles the watermark fragments scattered over line starts (e.g. "With ii. The period..." in Clause 26), page numbers and footnotes. In this PDF clause headings sit at column 0 or a few spaces in, so the heading match is `^(\d+)\.\s+Title` with the clause number required to be the next in sequence.
- Chunking: one chunk per sub-paragraph (i), (ii), ...; lettered items (a), (b) stay inside their paragraph unless the paragraph is over 1,000 characters (spec said to split on (a), (b) as well; this is a deliberate deviation to keep context). Stored with `doc_id, doc_title, chapter, clause, para, heading, content`. Ingestion replaces the document's rows in one transaction, so re-running is idempotent (tested).
- Retrieval: `websearch_to_tsquery` terms joined with OR (the AND form finds nothing for natural questions), candidates from the `tsv` GIN index. Ranker: BM25 (default) or `ts_rank_cd`. See `docs/RAG_EVAL.md` for why.
- Answers are extractive (verbatim stored text, up to 3 chunks) with `Clause N, para (x)` citations, and every response, including "Not found", carries the mandatory Withdrawn-source notice. `answer.js` has a `rewrite` hook for the S6 LLM switch; it is not wired to any provider yet.

**Measured (20 labelled questions; see `docs/RAG_EVAL.md`):** clause hit@1 **85%**, hit@3 **90%** (BM25), versus 55% and 85% for the first `ts_rank_cd` baseline; 6/6 out-of-scope questions refused. Two misses at 3, both listed with reasons in the doc. Ranker choice and threshold were tuned after seeing the baseline results on this same set, so the figures are optimistic; this is stated in the doc.

**Tests:** `rag.test.js` 8 tests (30 clauses and 3 annexes present in order, no watermark residue, paragraph splitting, footnotes dropped, idempotent ingestion, verbatim quoting with notice, out-of-scope refusal, API and validation, eval run). **Full suite: 39/39 passing** (rules 8, journey 6, analytics 7, simulate 10, rag 8), about 150 s. API started and answered the compliance endpoints.

**Known gaps**
- `README.md` does not exist yet; the spec's "README quotes the measured hit rates" is done in S7, which must copy the numbers from `docs/RAG_EVAL.md`.
- The eval writes `docs/RAG_EVAL_RESULTS.json` on every test run (generated file).
- Lexical retrieval misses abbreviation/synonym questions (DLG).

## S3. A/B experiment framework (done)

**Built** (`server/src/experiments/`: `assign.js`, `simulateExperiment.js`, `analyse.js`, `brief.js`, `routes.js`)
- **Definition:** `key, name, hypothesis, primary_metric (acceptance_rate | disbursal_rate), guardrails[] ({metric: default_rate | median_tat | complaint_rate, tolerance {type abs|rel, value}}), variants [{name, weight}]` (exactly two, control first, integer weights summing to 100), `status`. Stored in the existing `experiments` table (its jsonb columns already fit; no change to existing tables).
- **Assignment:** `sha256(unitId|key)` first 4 bytes mod 100 against the weights. Deterministic; different keys split users independently (tested).
- **Cohort:** separate synthetic cohort generated on demand by `POST /api/experiments/:key/run` (seeded, default 40,000 units, known true effect, optional `drop_treatment_rate` to fake a logging bug). Stored in a **new table `experiment_units`** (migration `003_experiment_units.sql`, new table only; existing tables untouched). `applications` and the funnel/RCA dataset are never written (tested). Baselines are illustrative constants (45% acceptance, 4% default, 1% complaint, 6 h median TAT).
- **Analysis:** two-proportion z-test with 95% interval; SRM check (chi-square, flagged at p < 0.001); guardrails as `ok` / `uncertain` / `breach` from the 95% interval against the tolerance (median TAT uses a normal approximation from the IQR). **Decision rule:** SRM flagged = hold; any breach = stop; primary significantly worse = stop; primary not significant = hold; otherwise ship. A guardrail whose interval straddles its tolerance does not block shipping (spec rule) but is listed as a "Watch" note.
- **Brief:** template-generated markdown (decision, hypothesis, setup, results, guardrails, SRM, rule, caveats), labelled synthetic.
- **API:** `GET/POST /api/experiments`, `POST /api/experiments/demo` (idempotent worked example "show the KFS summary above the Accept button"), `POST /:key/run`, `GET /:key/analysis`, `GET /:key/brief`. Inputs validated (400/404/409/422).

**Measured behaviour (from the test run, n = 40,000, 30 seeds each):** a true +2 pt acceptance effect shipped 30/30; no effect shipped 1/30; the 95% interval covered the true effect 29/30. A separate 60-seed check I ran (not part of the suite) gave: +2 pt effect ships 57/60, no effect ships 1/60 but stops 3/60 on a significantly negative fluke, interval coverage 55/60. A +3 pt default-rate shift stops 60/60. So at this size a real effect is occasionally missed (3/60) and noise occasionally causes a "stop".

**A lesson worth knowing:** my first draft held shipping whenever a guardrail was "uncertain". That is stricter than the spec and, at 40,000 units, made "ship" close to a coin flip because the default-rate interval (about +/-0.9 pt on about 4,200 loans per arm) rarely fits inside a 1 pt tolerance. I reverted to the spec's rule (breach blocks) and surface "uncertain" as a watch note. With fewer units, guardrails will more often read "uncertain".

**Tests:** `experiments.test.js` 18 tests (assignment stability, balance 50/50 and 90/10, cross-experiment independence, variant validation, normal and chi-square tails against known values, textbook z-test, SRM, no-effect = hold, real effect = ship with the true effect inside the interval, guardrail breach on default rate and on TAT = stop, significant drop = stop, skewed split = SRM hold, false-positive rate, power over many seeds, brief content, API flow incl. replace-on-rerun and validation). **Full suite: 57/57 passing** (rules 8, journey 6, analytics 7, simulate 10, rag 8, experiments 18), about 141 s. API started with migration 003 applied and the brief endpoint returned the report.

**Known gaps**
- Single look, no sequential-testing or multiple-comparison correction (stated in the brief).
- Only two variants; one primary metric; no CUPED or stratification.
- The complaint guardrail is a simulated proxy.
- The brief is template-only until S6 (optional LLM phrasing).

## S4. Mock controls and live load (done)

**Built**
- `server/src/mock/controls.js`, mounted at `/api/mock` (in `app.js`): `POST /api/mock/config` (validated patch), `POST /api/mock/scenarios/:name`, `GET /api/mock/status?minutes=`.
- **Validation:** `multiplier` 0.1 to 50; `errorRate`/`timeoutRate` 0 to 1; `baseMs` 1 to 60000; `forceScore` null or integer 300 to 900 (bureau only); `forceVerified` null or boolean (KYC only); unknown keys and empty patches are 400, and a patch with any bad field changes nothing. The existing `POST /mock/config` (in `mock/routes.js`, a small edit) now uses the same validation; before, it accepted any value.
- **Scenarios:** `normal`, `bureau_slowdown` (x5, 35% timeouts, 3% errors, the seeded 13 Oct shape), `bureau_outage`, `kyc_slowdown`, `kyc_outage`. A scenario resets only the provider it touches.
- **Status:** per-provider recorded calls in a window (ok, timeouts, errors, p50, p95) plus applications and `BUREAU_UNAVAILABLE` referrals, read from `api_calls` and `applications`.
- `scripts/live-load.js` (`npm run live-load -- --n 200 --concurrency 4`): sends fabricated journeys through the real API; `--scenario NAME --from I --to J` injects an incident mid-run and switches it off; prints a running tally and the recorded latency from `/api/mock/status`. Clear error and exit code if the API is not running or arguments are bad.

**Measured (live injection test, scale 0.02, 15 journeys per phase):** bureau median recorded latency 1,532 to 1,928 ms while healthy, **6,000 ms (the timeout) under the slowdown**; `BUREAU_UNAVAILABLE` referrals **0/15 healthy, 12 to 14 of 15 under the slowdown** (varies by run); back to 0 after recovery. A real-server run of the script (60 journeys, slowdown for journeys 20 to 45, throwaway database) showed bureau timeouts rising to 20 of 50 calls and 17 fallback referrals.

**Tests:** `mock_controls.test.js` 6 tests (validation on both config endpoints with nothing changed on a bad patch, scenarios, the live-injection test above with recovery and the status view, the script's tally, mid-run scenario injection and switch-off, failure modes). **Full suite: 63/63 passing** (rules 8, journey 6, analytics 7, simulate 10, rag 8, experiments 18, mock controls 6), about 155 s.

**Things to know**
- Failed provider calls are recorded with the nominal timeout (6,000 ms) as their latency, so a slowdown shows up as p95 pinned at 6,000 ms, as in the seeded data.
- At the test default `LATENCY_SCALE` (0.002) a 5x slowdown cannot exceed the 50 ms client-timeout floor, so only the random timeouts bite; the injection test therefore sets the scale to 0.02 (the demo default) for itself. If the demo is run with a much smaller scale, use `bureau_outage` for a guaranteed fallback.
- **Live journeys write real rows into the dev database** (the same one the workbench reads), so `dataRange` then extends to today and the analytics will see them. The journey API stores `is_synthetic = false` by default (existing behaviour, not changed here); the applicants are fabricated, but the flag does not say so. I would suggest a small change so API-created applications are tagged synthetic, but that alters existing behaviour, so it needs your approval. `POST /api/admin/reseed` wipes live rows.
- The mock config is in-process state: it is lost on restart and is per server process.

## S5. React workbench UI (done)

**First, two changes you approved or that unblocked the UI**
- **Synthetic flag (approved):** `createApplication` in `journey/service.js` now stores `is_synthetic = true` for every API-created application (one-word change in the insert), with a test in `journey.test.js`. This also covers the live-load script.
- **Analytics performance (bug that blocked S5, fixed in `analytics/data.js` only):** `loadApps` took about 56 s for the full dataset (EXPLAIN ANALYZE: a per-application correlated subquery on `api_calls` ran a bitmap-AND 26,879 times). It now aggregates events and API waits once each and joins them. Output is identical: I compared the old and new function row by row on three windows (2,067, 2,233 and 2,120 applications) and they match exactly. Full-range load: 56 s to 0.84 s; `/api/anomalies` 56 s to 0.66 s; `/api/funnel` 62 s to 0.74 s; `/api/rca` 24 s to 0.42 s. `analytics.test.js` went from about 130 s to 17 s, so the full suite is faster too. No schema or index change.
- **Label bug found through the UI:** the simulator labelled an unmodified baseline "v2+overrides". It now says "+overrides" only when something was overridden (test added).

**Built** (`web/`, Vite + React 18 + Recharts, hand-written CSS with light and dark themes, no CDN)
- Global banner "Synthetic data. Not a real lending system." on every page; hash routing; Express serves `web/dist` in production; `npm run dev` starts the API (4000) and Vite (5173, proxying `/api` and `/mock`).
- **Journey:** apply, KYC, eligibility, offer (shows the full KFS and reason codes for refer/reject), accept; later steps stay locked until the earlier one passes; event trail.
- **Funnel:** daily step-conversion lines with release markers (amber) and policy-change markers (purple), date range and segment filter, funnel bars, applications per day, segment breakdown table.
- **Anomalies:** flagged days with rate, baseline, drop, z, and an "Investigate" link that opens the RCA; conversion-vs-baseline chart with flagged points; a note that some flags are chance.
- **RCA:** drop decomposition (baseline vs the day), ranked hypotheses with score bars, evidence, verdict chips, hourly provider latency chart with the alert threshold, narrative and the causal caveat.
- **Simulator:** edit score cut-offs, FOIR caps, income minimum and loan multiple, run, baseline/candidate/change cards, expected disbursals vs expected NPA chart, decision mix, by-segment table, top reason codes, and the synthetic-data notice.
- **Compliance:** question box with example questions, extractive answers with clause citations, the Withdrawn-source notice always visible, "Not found" handling, and the corpus clause list.
- **Experiments:** definition list, cohort controls (true effect, default shift, lost-treatment-users bug), result with decision chip, primary metric, SRM, guardrail table, and the generated brief rendered as markdown.
- **Mock controls:** scenario buttons, per-provider sliders and forced values, and the recorded-calls table (refreshes every 5 s).

**Checked in a real browser (Edge-based pane, built UI served by Express):** funnel chart with the 6 to 8 Oct Android dip and all markers; RCA for 13 Oct showing the bureau slowdown ranked first at 100% with the 11:00 to 19:00 latency spike and the Android and iOS releases ruled out; simulator run (FOIR hard cap 0.45); compliance question returning Clause 10 with the notice; experiments page with the SHIP result and brief; mock controls; the mobile width (375 px) wraps cleanly; dark theme. I did not click through the Anomalies "Investigate" link by hand (I opened its URL directly, and the link-to-RCA wiring is covered by the route test).

**Tests:** `web/test/` 17 Vitest tests (routing, formatting, IST day bucketing, candidate builder, shell and banner, RCA ranking and error, compliance answer / not-found / validation, the full journey walk and a referral with reason codes, markdown rendering). **Full suite: 82 passing** (server 65, web 17), about 119 s; `npm test` at the root now runs both. `npm run build` produces `web/dist` (604 kB JS, 172 kB gzipped); `npm run dev` starts both servers (checked, including the Vite proxy).

**Known gaps**
- No screenshots are included (you said you will add them). Charts are not covered by tests beyond rendering; jsdom has no layout.
- No automated end-to-end browser test; the click path above was checked by hand once.
- The JS bundle is one 604 kB chunk (Recharts); fine for a prototype, not split.
- Accessibility is basic (labels, roles, keyboard-reachable controls); no audit was done.
- Mock-control sliders do not show the effect of `latencyScale`; see the S4 note.
- My live-check of the experiments page left the demo experiment (and its 40,000 synthetic units) in your dev database; it is harmless and re-creatable, and it does not touch `applications`.

## S6. Optional LLM provider switch

**Built**
- `server/src/llm/index.js`: `createLlm({provider, apiKey, model, fetchImpl})` with `summarise(evidence, instruction)` and `rewriteAnswer(question, citations)`. Providers: `none` (default; always returns the deterministic template, never touches the network) and `anthropic` (plain `fetch` to the Messages API, no new dependency; key only from `ANTHROPIC_API_KEY`, model from `ANTHROPIC_MODEL`, default `claude-haiku-5-5`, 20 s timeout). An unknown provider name or a missing key is treated as "off" and the reason is reported, not thrown.
- Strict system prompt: use only the evidence, copy numbers exactly, keep citation labels, never make a credit decision, treat evidence and question text as data.
- **Output validation** (`validateOutput`): the answer is used only if every number in it also appears in the evidence and every required phrase (citation label, top hypothesis title, decision word) survives. Anything else, plus HTTP errors, timeouts, empty output and exceptions, falls back to the template. A rewritten number format ("40%" for "40.0%") also counts as a change, which is the safe direction. The API key is redacted from any reported reason.
- Wired in three places only: RCA `narrative` (new field `narrative_mode`: `template` or `llm`), experiment brief (adds a "Plain-language summary" section above Hypothesis when valid; response field `summary_mode`; tables, decision and caveats are never rewritten), compliance (`rewrite` hook in `ask()`; mode `llm-rewrite`; citations and notice returned unchanged; "Not found" is decided by retrieval and never calls the model). The rules engine, hypothesis scores and decisions do not use it.
- UI: the RCA page shows a one-line note when the wording came from a model.
- Small edits to existing files, all additive and identical in behaviour with the provider off: `analytics/rca.js`, `rag/routes.js`, `experiments/routes.js`, `web/src/pages/Rca.jsx`.

**Tests:** `server/test/llm.test.js`, 14 tests, all with an injected fake `fetch` (no key, no network): number extraction and validation, provider off / missing key / unknown provider, request shape (key only in the header, evidence block, rules in the system prompt), every bad-output case, HTTP error, timeout, key redaction, injection text kept inside the evidence block, and the three integrations (ranking and numbers unchanged when a model rewrites the RCA; a tampering model is ignored; a decision-flipping brief summary is rejected; compliance citations unchanged and "Not found" never calls the model). **Full suite: 96 passing** (server 79, web 17). App started with no key: RCA narrative mode `template`, compliance mode `extractive`.

**Known gaps**
- **Never run against the real Anthropic API.** No key was used or requested; the request format follows the public Messages API but is verified only against the fake. Try it once with `LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run dev:api` before relying on it.
- The number check catches changed or invented digits, not spelled-out numbers ("three"), wrong causal wording or dropped nuance. That is why the template stays the default and the ranking, scores and decisions are computed by code.
- The compliance rewrite requires only that one citation label survives and no new numbers appear.
- No UI indicator yet for the compliance and brief modes beyond the API fields.

## S7. Documentation (done)

**Written:** `README.md` (what it is, quick start, architecture, API table, planted scenarios, measured results, optional LLM, honest limitations, repo map), `docs/PRD.md`, `docs/METRIC_TREE.md`, `docs/DEMO_SCRIPT.md` (5 minutes, one story per tab), `docs/INTERVIEW_QA.md` (30 numbered questions plus extras, each pointing to code). `docs/RAG_EVAL.md` was finalised in S2 and is quoted, with its tuning caveat, in the README.

**Numbers were re-measured, not copied from memory:** I started the API on the seeded database and read `/api/anomalies` (6 flags: 29 Sep, 5 Oct, 6/7/8 Oct, 13 Oct; 5 Oct is the chance false alarm), `/api/funnel` (26,879 started, 5,010 disbursed, overall 18.6%; step rates 81.8%, 86.2%, 48.8%, 58.1%, 93.3%) and `/api/rca` for 13 Oct (bureau 100%), 7 Oct (Android 2.3 100%), 29 Sep (policy 71%) and 5 Oct (policy 19% "possible", the known artefact). Experiment and RAG figures are quoted from the S3 and S2 notes.

**Checked against the code:** API list vs the route files, environment variables vs `config.js`, guardrail tolerances vs `experiments/routes.js`, UI button names vs the pages, live-load flags vs the script. No code changed in S7, so the S6 suite result stands (96 passing); I did not re-run it.

**Known gaps**
- No screenshots (placeholder comment in the README for you to fill).
- The demo script's click path was written from the code and earlier browser checks, not re-run end to end as a rehearsal.
- `docker-compose.yml` and `.env.example` pre-date this work; the compose file still lists Redis, which the app does not use. The README says compose is optional and unused. Cleaning it up belongs to S8/S9 and touches an existing file, so I will ask first.
- The README test count (96) will go stale as tests are added.

## S8. Hardening (done)

**Error contract.** `app.js` now has one error handler: `{ error }` for every failure (plus `{ errors: [...] }` for lists such as an invalid ruleset). `HttpError` and body-parser errors reach the client with a written message (400 bad JSON, 413 over 1 MB); a Postgres unique violation is 409 and a data exception is 400 with a generic message; everything else is a **generic 500** and the real error is logged server-side only. Unknown `/api` and `/mock` paths are a JSON 404, and `x-powered-by` is off.

**Input validation** (`server/src/http/validate.js`, used by the routes): application ids must be positive int4 (otherwise 404, where `abc` used to be a 500 from Postgres); calendar-valid `YYYY-MM-DD` dates (`2026-02-30` used to reach the database); funnel `segment` checked against the allowed list and `value` needs a segment; repeated query parameters rejected; reseed `seed`/`perDay` bounded; JSON bodies must be objects; `POST /api/applications` checks text fields (type, length, control characters) and `new_to_credit`; `POST /api/rules` now validates version, timestamp, note and the full ruleset (finite values, field names, pricing) and returns 409 for a duplicate version (before: a 500). The experiments, compliance and mock-control routers already validated and keep their messages.

**Process safety** (`index.js`, `db/connection.js`): the pool logs idle-client errors instead of crashing; an uncaught exception or rejection is logged and the process exits after closing the database; a busy port prints a clear message.

**Two Windows bugs found and fixed (`db/connection.js`)**
1. **The mysterious first-start crash ("uncaught undefined") is explained and fixed.** It happens when a previous dev server was killed (Task Manager, `Stop-Process`, a crash) and its PostgreSQL stays alive on port 54330: `server.start()` rejects with `undefined`. Start-up now reuses a reachable instance and otherwise throws a readable message. I reproduced it this session before fixing it.
2. **Orphaned PostgreSQL workers.** After a normal, graceful close, about one test file in three left an `io_worker` process running (I counted 3 left after a full suite, and found 15 orphans from earlier sessions on this machine, all under this project's `node_modules` or my scratch copy; I ended those). `close()` now remembers the postmaster's descendants, stops it, and ends any `postgres.exe` still a child of that family. After the change a full server suite left **0** processes, and so did `npm run check`. Only descendants of the process this module started are touched, and `taskkill` is restricted to `postgres.exe`; a reused pid belonging to another postgres.exe is theoretically possible but would need to happen within seconds.

**`npm run check`** = `npm test && npm run build`. **Clean checkout:** I copied the project without `node_modules`, `.data`, `dist` and the generated eval JSON to a scratch folder, ran `npm install` and `npm run check`: 91 server and 17 web tests passed and the build succeeded (that run was before the process-cleanup change; the final `npm run check` in the project also passed).

**Dependencies.** `npm audit` on a clean install showed 7 findings. I ran the non-breaking `npm audit fix`: runtime dependencies are now clean (`body-parser` high severity patched to 1.20.9 through the lockfile). Six remain in dev tooling (vite/esbuild, vitest, tinypool and related) and need a major-version upgrade (`--force`); I did not do that. They affect the dev server and test runner only.

**Tests:** `server/test/hardening.test.js`, 12 tests: JSON 404s, malformed and oversized bodies, a generic 500 that logs the real error, Postgres error mapping, ids that cannot exist on all five application routes, 14 bad application bodies, 13 bad ruleset bodies plus duplicate and listing, 16 bad query strings and 7 bad reseed bodies, the other routers' error shape, and the validators themselves. A leak check scans every error body for stack traces, paths and SQL. **Full suite: 108 passing** (server 91, web 17).

**Verified live on Windows:** the API started, `/api/applications/abc` is a 404 JSON, bad JSON is a 400, `from=2026-02-30` is a 400, health and RCA answer.

**Known gaps**
- **No authentication.** `POST /api/admin/reseed` (wipes the data) and `POST /api/rules` (changes the live credit policy) are open. Fine for a local demo, not for a shared host; the README says so.
- `docker-compose.yml` is unchanged and still lists Redis, which the app does not use (I will ask before editing it; see S9). No `Dockerfile`; Docker was not run.
- The worker-leak fix is Windows-only code, tested only on this machine; on macOS and Linux the original `stop()` behaviour is unchanged.
- No rate limiting on the real API (only the mock providers have the stand-in limiter), and CORS is open.
- Request-body validation for the experiments and mock-control routes was done in earlier steps and not re-audited line by line, only through the shape tests.

## S9. Claims audit and resume (done)

**Written:** `docs/CLAIMS_AUDIT.md`: 48 numbered claims from the README, PRD, Q&A and spec pitch, each with the file or test that proves it and a status (built and tested / built and measured once / partial / not built), a list of claims that must not be made, and the resume text (stack line, seven bullets mapped to claim numbers, a one-line version, and the caveats to volunteer). There was no existing resume text in the repository, so the bullets are new; replace your own version with them or compare line by line.

**`docker-compose.yml` (you approved):** the Redis service is removed; PostgreSQL stays, with usage comments. Never run.

**What the audit found, and what I did about it**
- The README's "6 flags, 5 planted, 1 false alarm (5 Oct)" and the 19% policy artefact had been measured by hand but **no test pinned them**. I added two tests to `analytics.test.js` that do.
- "The LLM never decides a credit decision" was only a rule I followed. I added a structural test in `llm.test.js`: nothing in `rules/`, `journey/`, `integrations/`, `data/` or `mock/` mentions the LLM module, and exactly three files import it (RCA, experiment routes, compliance routes).
- Claims that are measured once and not pinned (stated as such in the audit): overall funnel rates, the simulator example (2.1 points, 1.42% to 1.37%), the 60-seed experiment check, the 56 s to 0.84 s loader timing, exact RCA percentages on 7 Oct and 29 Sep.
- Claims that are **not** supportable: real Anthropic API use, RBI's prescribed APR, calibrated NPA, macOS/Linux, Docker, authentication, anything about real traffic. The audit marks each.

**Suite:** `npm run check`: **111 tests passing** (server 94, web 17) and the build succeeds. README and PRD counts updated.

**Housekeeping you should know about:** while measuring process leaks I found a dev server from the S5 browser checks (a `concurrently` / `node --watch` tree started on 26 Oct about 02:26, with its embedded PostgreSQL) still running and restarting itself whenever I edited a server file. It was this session's leftover, not something of yours; I stopped the database gracefully (`pg_ctl stop -m fast`), ended the tree, and ended the orphaned PostgreSQL workers that belonged to this project. Ports 4000, 5173 and 54330 are clear and no project postgres.exe is running.

**Known gaps:** same as S8 plus the audit's "not built" list; S10 (calibration) is the remaining spec step.

## S10. Calibration (skipped by the owner's decision)

The owner decided to keep the generated synthetic dataset as it is; it is enough for the demo. No calibration file, source log or generator change was made, and no data was downloaded. `generate.js`, the seeded dataset and every figure quoted in the docs are unchanged. The README already states that default risk is a hand-set formula and that absolute NPA levels are illustrative. If calibration is wanted later, the plan is in section 8 of `docs/LOANLENS_BUILD_SPEC.md`.

## Fix: "Internal Server Error (500)" when running `npm run dev` (after S9)

**Symptom:** the website opens on port 5173 but every page shows a 500. **Cause:** the website is only the Vite dev server; it forwards `/api` to the API on port 4000. The API had not started, so Vite's proxy answered with a 500. The API failed because port 54330 was taken by a dead PostgreSQL: its main process was gone but a child (`startup`) survived and still held the listening socket, so nothing answered and a new one could not bind. This is left behind when a dev run is killed hard (closing the terminal, a forced stop). The check I added in S8 (reuse a reachable instance) only handles a healthy leftover, not this half-dead one.

**Fix (`server/src/db/connection.js`):** if the embedded server cannot start, Windows start-up now looks for this project's own `postgres.exe` processes whose parent no longer exists (`strandedPostgres`, matched on this project's folder and `@embedded-postgres` path), ends them, waits briefly and retries once. It never touches other PostgreSQL installs or other projects. If nothing is found, or the retry fails, you get the readable error from S8. `server/test/hardening.test.js` has a unit test for the selection logic (own vs other project, other postgres, live parent, non-postgres).

**Verified:** reproduced the 500 (Vite proxy `ECONNREFUSED`, API log "Could not start the embedded PostgreSQL"), ended the stranded process, and the API and website came up; the Funnel page loaded with data and no console errors; `npm run check` passes (95 server and 17 web tests). **Not verified:** the new kill-and-retry path itself. I could not recreate the half-dead state on demand (killing the postmaster left no stranded child), so only the selection logic is tested, not the live retry.

**If it ever happens again and the retry does not clear it:** end any `postgres.exe` under `LoanLens\node_modules\@embedded-postgres` in Task Manager, then run `npm run dev` again.

## Responsive UI and eight evaluate-and-fix loops (after S9)

Full write-up, with every bug, every measurement and everything left open: [`IMPROVEMENT_LOOPS.md`](IMPROVEMENT_LOOPS.md). Summary:

- **Responsive UI (the main task):** grids that size themselves, a one-line top bar, scrolling sticky tabs, every table in a scroll container, fluid gutters, touch targets and 16 px inputs on phones, safe-area insets, chart legends readable in light theme. No overflow and no sub-4.5:1 text on all 8 pages, light and dark, 320 to 1440 px (checked by script in the browser pane). Not verified on a real device.
- **Evaluation tooling added:** `scripts/evaluate.mjs` (170 checks, 15 notes, throwaway database), `scripts/evaluate-detector.mjs` (re-rolls the generator), `scripts/evaluate-experiments.mjs` (decision-rule repeats).
- **Bugs fixed:** RCA scored "likely 100%" causes on a quiet day; parallel requests duplicated offer events and bureau calls; experiment effects unbounded; the language-model check ignored signs and length and let a digit-free invented claim through; list-marker-only questions got answers; no security headers; a missing asset returned the HTML page; the application API exposed the synthetic latent score, default probability and `would_default`; analytics recomputed every time (now cached; 12 parallel requests 6.3 s to 1.3 s); no page titles or h1; the "Request failed (500)" message when the API is down; low-contrast legends and chips; scripts crashed without `argv[1]`; the first screen shipped 608 kB of script (now 161 kB); charts drew lines across gaps.
- **Model improvements:** a sustained-shift detector; a significance gate and a declared-step prior in the RCA; minimum detectable effect in experiments; a simulator backtest; a groundedness check on language-model output; a held-out retrieval set.
- **Measured and open:** compliance refusal 4 of 6 on unseen unrelated questions; the daily detector found the policy change in 2 of 8 re-rolled datasets (the shift detector 7 of 8, settings tuned on those 8); the simulator under-predicts disbursals by 17%; no authentication; no real-device or screen-reader testing.
- **Tests:** 131 passing (server 109, web 22); `npm run check` passes.
- **Files touched in existing code** (all asked for by this task): `analytics/{rca,anomaly,data,simulate,routes}.js`, `journey/{service,routes}.js`, `experiments/{analyse,brief,routes}.js`, `llm/index.js`, `rag/search.js`, `data/seed.js`, `app.js`, `rag/ingest.js`, `db/migrate.js`, and in `web/` the styles, `App.jsx`, `ui.jsx`, `lib.js` and the pages. `generate.js` and the dataset were not touched. Two existing test expectations were changed deliberately: the markdown heading is now an `h3` (the page has one `h1`), and the LLM RCA test uses 7 Oct (a strong signal) because 13 Oct is not significant in its 150-a-day mini dataset.
