# LoanLens: One-Hour Interview Study Guide

Everything below is grounded in the repository (code, README, PRD, metric tree, demo script, eval docs). All data is **synthetic**. When you quote a number, say "measured on the synthetic dataset".

**How to use this in one hour**

| Min | Read | Goal |
|---|---|---|
| 0-8 | Sections 1-2 | Pitch + vocabulary: say the project in 60 seconds and 3 minutes |
| 8-18 | Sections 3-4 | The problem, users, metrics, architecture, the data you built |
| 18-45 | Section 5 (modules) | What / why / how / weaknesses of each part |
| 45-55 | Sections 6-7 | Numbers cheat-sheet + honest limitations (say these *before* they find them) |
| 55-60 | Section 8-9 | Skim the twisted questions; memorise the "do not claim" list |

If you have only 20 minutes: read 1, 6, 7, and the **bold answers** in 8.

---

## 1. The pitch (memorise)

### 60 seconds
"LoanLens is a workbench for a digital-lending product manager. When funnel conversion drops, a PM has to find out where, why, what to change, and whether the change is allowed, and those answers normally sit in four tools owned by four teams. LoanLens puts the loop in one place: it **detects** the drop, **ranks likely causes** by how much of the drop each one explains, lets the PM **simulate a rule change** and see conversion next to expected NPA, **checks the change against RBI's digital lending directions** with clause citations, and **tests it** with an A/B framework that has guardrails. Credit decisions come from a deterministic rules engine, never from an LLM. It runs on synthetic data where I planted four incidents so I could check that the method finds the known answers, and I'm upfront about what it can't prove."

### 3-minute walkthrough (in this order)
1. **Journey**: a working loan application: apply, KYC, eligibility, offer with a Key Fact Statement, accept. Rules engine decides; bureau and KYC are mock APIs that I can slow down or break.
2. **Funnel**: 40 days, ~27k applications. Overall disbursal conversion 18.6%; the weakest step is eligibility to offer (48.8%).
3. **Anomalies**: detector flags 6 day-steps. 5 are planted incidents, 1 is a chance false alarm (5 Oct).
4. **RCA** on 13 Oct: bureau slowdown ranked first; an iOS release the same morning is ruled out.
5. **Simulator**: change the FOIR cap and see approvals and expected NPA side by side.
6. **Compliance**: ask "what is the cooling-off period?"; get the quoted clause with a citation, plus a warning that the PDF is stamped Withdrawn.
7. **Experiments**: A/B with a sample-ratio check and guardrails; it refuses to ship on a skewed split.

### One-line answers to "why did you build this?"
- *Product reason:* "A conversion fix in lending can quietly raise credit risk and break compliance, so a PM needs those views together."
- *Personal reason:* "I wanted a project that shows product thinking (problem, users, metrics, trade-offs) backed by working engineering, not a clone app."

---

## 2. Vocabulary you must be fluent in

| Term | Meaning (say it simply) |
|---|---|
| **Funnel / conversion** | Share of people who reach the next step. "Step conversion" = reached step / reached previous step |
| **KYC** | Know Your Customer: identity verification before lending |
| **Credit bureau / score** | Agency (e.g. CIBIL) that reports a borrower's credit history as a score. Here a mock API. Higher = safer |
| **New-to-credit** | Person with little or no credit history |
| **EMI** | Equated monthly instalment: fixed monthly payment |
| **FOIR** | Fixed obligations to income ratio = (existing EMIs + new EMI) / monthly income. A cap stops over-borrowing |
| **APR** | Annualised total cost of the loan including fees. In this repo it's an illustrative calculation, not RBI's prescribed method |
| **KFS** | Key Fact Statement: the standard terms sheet a borrower must see before accepting |
| **Cooling-off** | Period after disbursal when the borrower can exit without penalty (I use 3 days as an illustrative lender value) |
| **NPA** | Non-performing asset: a loan gone bad. Here "expected NPA" = expected default share of expected-disbursed amount |
| **BRE / rules engine** | Business rules engine: applies versioned rules to approve/refer/reject |
| **Reason codes** | Machine-readable reasons for a decision (e.g. `FOIR_TOO_HIGH`) |
| **Refer** | Send to a human credit officer instead of auto approve/reject |
| **TAT** | Turnaround time: application start to disbursal |
| **RCA** | Root-cause analysis |
| **Counterfactual** | "What would the metric have been if this cause hadn't happened?" |
| **Dose-response** | If a cause is real, more exposure should mean a bigger effect (longer wait, lower conversion) |
| **Difference-in-differences** | Compare the change on the affected group to the change on an unaffected group to strip out market-wide movement |
| **Z-score / MAD** | z = how many "standard units" a value is from its baseline. MAD = median absolute deviation, a robust spread measure |
| **SRM** | Sample ratio mismatch: the A/B split isn't what you configured, so the data is untrustworthy |
| **Guardrail metric** | A metric that must not get worse while you improve the main one (default rate, TAT, complaints) |
| **RAG** | Retrieval-augmented generation: find relevant text, then answer from it. Here the answer is *extractive* (quotes), not generated |
| **BM25 / full-text search** | A keyword ranking method; Postgres full-text search finds candidate paragraphs |
| **Reject inference** | Estimating how rejected applicants would have performed, because their defaults are never observed |
| **DLA / LSP / RE** | Digital lending app / lending service provider / regulated entity (RBI terms) |

---

## 3. The product

### 3.1 Problem
A digital lender's PM watches a funnel: **apply -> KYC -> eligibility -> offer -> accept -> disburse**. When a step's conversion drops, four questions follow:
1. **Where** did it drop?
2. **Why?** App release? Slow bureau? Policy change? Different mix of applicants? They look alike from outside.
3. **What can we change** without raising bad loans?
4. **Is that change allowed** under RBI rules?

The answers live in product analytics, API monitoring/release logs, the rules console, and a PDF of regulations, owned by analytics, engineering, risk and compliance. The PM chases people; a one-day incident takes days to diagnose; the fix is argued without evidence. Lending adds a trap: a conversion fix can raise credit risk.

### 3.2 Users
- **Primary: lending PM.** Needs fast, defensible answers they can take to risk and engineering.
- **Reviewers:** risk analyst (sees NPA next to conversion), compliance officer (sees clause citations and the "Withdrawn" warning), engineer/SRE (sees provider-latency and release evidence).

### 3.3 The loop (the product in one table)

| Stage | Question | What LoanLens does | Code |
|---|---|---|---|
| Detect | Where? | Daily step-conversion anomaly detection | `analytics/anomaly.js` |
| Diagnose | Why? | Ranks causes by counterfactual share of the drop explained | `analytics/rca.js` |
| Decide | What to change? | Replays applicants through a candidate ruleset: conversion + expected NPA | `analytics/simulate.js` |
| Check | Allowed? | Cited answers over the RBI Directions | `rag/` |
| Experiment | Did it work? | A/B with SRM check, guardrails, ship/hold/stop | `experiments/` |

### 3.4 Metric tree (north star + guardrails)
**North star: disbursal conversion = loans disbursed / applications started = 5,010 / 26,879 = 18.6%.** It's the product of five step conversions:

| Step | Measured | What moves it |
|---|---|---|
| Start -> KYC | 81.8% | KYC provider health, app release (document capture), device mix |
| KYC -> eligibility (pre-screen) | 86.2% | Age/income rules, applicant mix |
| Eligibility -> offer viewed | **48.8% (weakest)** | **Bureau latency/errors**, credit rules (score, FOIR), mix |
| Offer -> accept | 58.1% | Rate, amount cut, KFS clarity/copy |
| Accept -> disburse | 93.3% | Post-acceptance checks |

Of everyone who starts: 8,244 are rejected and 5,370 are sent to manual review at some point.

**Guardrails:** NPA (expected default share), TAT (median start-to-disbursal), complaints (simulated proxy). *A conversion gain that raises NPA is not a gain*, which is why the simulator never shows one without the other.

**Why the RCA splits a drop into converted / abandoned / rejected / referred:** a drop from *rejections* is a policy matter (risk team); a drop from *abandonment* is a performance matter (engineering/UX). Different owners, different fixes.

### 3.5 Scope decisions you made as the PM (be ready to defend)

| Decision | Why |
|---|---|
| Synthetic data with planted incidents | Real lender funnel data is confidential; planted answers let me test the method |
| Deterministic rules, no ML scorecard | Lending decisions must be explainable and auditable; also out of scope for a PM tool |
| LLM optional, wording only | Compliance and credit can't tolerate invented facts |
| Extractive compliance answers | A quoted paragraph is safer than a fluent wrong answer |
| Non-goals: auth, real bureau/KYC integration, collections, multi-tenant, ML credit model, auto-acting on the PM's behalf | Keep the prototype about the decision loop |
| Not integrated with my Rate Limiter/TaskForge | They're separate projects; LoanLens only has a small stand-in limiter in front of its mock APIs |

---

## 4. Architecture and data

```
React + Vite + Recharts (web/)  --REST /api-->  Express API (server/src, Node ESM)
 Journey | Funnel | Anomalies | RCA          journey/      apply -> KYC -> eligibility -> offer(KFS) -> accept
 Simulator | Compliance | Experiments        rules/        versioned JSON rulesets, deterministic engine
 Mock controls                               analytics/    loadApps -> funnel -> anomaly -> rca ; simulate
                                             rag/          ingest -> search (FTS + BM25) -> answer (extractive)
                                             experiments/  assign -> analyse -> brief
                                             llm/          optional, phrasing only, outputs validated
                                             integrations/ providerClient (timeout, 1 retry, idempotency, fallback)
                                             mock/         bureau + KYC providers, incident controls
                                                  |
                                       PostgreSQL (embedded, or DATABASE_URL)
                    applications, events, api_calls, releases, rule_versions,
                    rag_chunks (tsvector+GIN), experiments, experiment_units
```

**Three design ideas to say out loud**
1. **Analytics are plain JavaScript over rows.** `loadApps` runs one SQL query that aggregates events and provider waits per application; funnel, detector, RCA and simulator are *pure functions* over those rows, so they're easy to unit-test and explain. (An earlier version with a per-row subquery took 56 s to load; one aggregation pass brought it to 0.84 s.)
2. **The rules engine decides; nothing else does.** Approve/refer/reject come only from `rules/engine.js` with reason codes. A test checks the credit code never imports the LLM module.
3. **Provider calls degrade safely.** Bureau times out -> one retry -> application is *referred* with `BUREAU_UNAVAILABLE`, not failed and not blindly approved.

### 4.1 The journey (what happens on each call)
1. `POST /api/applications` validates input (age 18-100, amount ₹10k-20L, tenure 6-84 months...), writes the row and an `application_started` event.
2. **KYC:** calls the mock KYC provider with an idempotency key; logs the API call (provider, latency, status) and `kyc_completed` or `kyc_failed`.
3. **Eligibility (prescreen rules):** age 21-60, income >= ₹25,000. Fail -> `application_rejected` with reason codes. Pass -> `eligibility_passed`.
4. **Offer:** *after* prescreen it calls the mock bureau for the score (the pull is deferred so you don't pay for a bureau call on people who fail basic rules), runs **credit rules**, then: reject / refer (`manual_review_started`) / approve (`offer_viewed` + a Key Fact Statement).
5. **Accept:** `offer_accepted` then a simulated `loan_disbursed`.
Each step checks the previous one happened (409 otherwise) and is idempotent on repeat.

### 4.2 The rules engine
- Rules are JSON rows: `{ field, op, value, stage, onFail, reason }`, stored in `rule_versions` with `effective_from`. Changing policy needs no redeploy.
- **v1** (launch): FOIR hard cap 55%, soft 45%. **v2** (from 29 Sep 2026): hard 50%, soft 40%.
- Other rules: age 21-60, income >= ₹25,000 (prescreen); score hard >= 650 (reject), soft >= 700 (refer) (credit).
- Pricing by score: 750+ -> 11%, 700+ -> 13%, else 16%. Max loan = 15x monthly income.
- Precedence **reject > refer > approve**. A missing field never approves: it refers (`BUREAU_UNAVAILABLE` if the score is missing).
- **Hard vs soft thresholds:** a clear failure is rejected; a borderline case goes to a human. That's the "refer" band.

### 4.3 The synthetic data (know this cold; interviewers probe it)
- **26,879 applications**, 10 Sep to 19 Oct 2026 (40 days), ~700/day with weekday and hour-of-day patterns, generated from a **fixed seed** (same seed -> same data). Stored with `is_synthetic = true`; UI shows a banner on every page.
- **Four planted stories** (IST):
  1. **Android 2.3 KYC regression**: 6 Oct 10:00 -> 8 Oct 15:00 (hotfix 2.3.1). KYC completion collapses on Android only.
  2. **Bureau slowdown**: 13 Oct 11:00-19:00. 5x latency + timeouts; users abandon while waiting for the offer.
  3. **Decoy iOS 5.2 release**: 13 Oct 09:00, a copy change that affects nothing. It exists to test whether the RCA blames "what changed today".
  4. **Policy v2**: 29 Sep, FOIR cap 55% -> 50%: a *step change* in rejections, not a dip.
- **Latent default probability** exists for every applicant (logistic in score, FOIR, employment, new-to-credit). A real lender only sees defaults on approved loans, so this is a **synthetic advantage** you must label.
- **Realism limits (say them first):** features are mostly independent (score isn't correlated with income/age), default coefficients are hand-set (not fitted), conversion rates are hand-tuned (not calibrated to Indian benchmarks), new-to-credit applicants get a score where real ones often have none, and there's no absolute loan cap or age-plus-tenure rule. **So absolute NPA levels (~1.4%) are illustrative; only directions and the incident detection are meaningful.** I chose not to regenerate or "calibrate" because the demo's claims rest on planted events, not on feature correlations, and any change would invalidate the tested numbers.

---

## 5. Module deep dives

### 5.1 Funnel and anomaly detector (`analytics/funnel.js`, `anomaly.js`)

**What:** for every step and day, decide if conversion is abnormally low.

**How, step by step**
1. Per day, compute step conversion = reached step / reached previous step (the denominator is the previous step, so a drop at one step doesn't pollute others).
2. **Baseline** = median of the previous 14 days' conversion (needs >= 7 days of history).
3. **Spread** = max( MAD x 1.4826 , binomial standard error sqrt(p(1-p)/n) ). The MAD scale makes it comparable to a standard deviation; the binomial floor stops quiet, low-volume days from producing absurd z-scores.
4. **z = (today - baseline) / spread.**
5. **Flag only if z <= -3 AND the drop is >= 3 percentage points** (statistically unlikely *and* practically meaningful).

**Why these choices**
- *Median/MAD, not mean/std:* robust to incident days already inside the window; an old outage shouldn't inflate the baseline.
- *14 days:* covers two weekly cycles; short enough to adapt to policy changes.
- *Both z and a minimum drop:* with big volumes a 0.5-point wobble can have a huge z but no business meaning.
- *Rule-based, not ML:* explainable, no training data needed, and a PM can read why it fired.

**Measured:** 6 flagged day-steps = 29 Sep (z = -3.4, policy), 6/7/8 Oct (KYC, Android), 13 Oct (offer viewed, bureau), plus **5 Oct (offer viewed, z = -4.2) = chance false alarm** (no planted cause; a 4-sigma outlier). Say it's "one observation, not an estimated false-alarm rate".

**Weaknesses:** at z = -3 over many steps and days, some chance flags are expected (multiple comparisons); no seasonality model beyond the rolling window; day granularity means a 8-hour incident (13 Oct) only barely trips it (z around -3.1 in an earlier run); no alert de-duplication.

### 5.2 RCA engine (`analytics/rca.js`), the centrepiece

**What:** given (day, step), rank the possible causes by how much of the drop each explains **on its own**.

**Setup:** today's cohort = people who reached the previous step that day; baseline = the prior 14 days. `lost = (baselineRate - todayRate) x n` = conversions lost. Needs >= 30 applications today and >= 100 in the baseline, else a 422 "not enough data".

**Decomposition (always shown):** of the people who reached the previous step, what share converted / abandoned silently / were rejected / were sent to manual review, today vs baseline. It tells you which *kind* of problem it is.

**Four hypothesis types, each a counterfactual**
1. **Provider latency (KYC or bureau):** *Dose-response.* Take applicants whose wait exceeded 1.2x the baseline 95th percentile ("hot") vs the rest ("cold"). Score = hot_count x (cold_rate - hot_rate) / lost, i.e. "if the slow-wait people had converted like everyone else, how much of the drop disappears?" Counts only if the difference is statistically significant (z >= 2.5, and >= 20 people in each group). Also reports hourly p95 latency, failure rate and the degraded hours (an hour with >= 15 calls and p95 more than 2x baseline).
2. **Release:** *Difference-in-differences.* For each release in the window, look at users on that platform and build after the deploy time (and before a later release on the same platform, e.g. the hotfix). Expected rate = their pre-release rate + the drift seen on other platforms. Score = affected_n x (expected - actual) / lost, only if significant. Needs >= 30 users on the new build.
3. **Policy change:** *Replay.* Run today's applicants through the previous ruleset and the new one; count those who are blocked only because of the new rules. Compare with the same share in the baseline period (so a change already baked into the baseline isn't double-counted). Score = extra blocked share x P(convert | approved) x n / lost. Only for steps the rules act on (eligibility, offer).
4. **Traffic mix:** *Re-weighting.* If today's mix of device/channel/employment/new-to-credit had the baseline's per-segment rates, what rate would we expect? The gap between baseline and that expected rate is the mix effect.

**Verdicts:** score >= 0.5 "likely", >= 0.15 "possible", else "ruled out". Scores are clamped to 0-1, can overlap, and need not sum to 1. A template writes the narrative (an LLM may reword it, with number checks).

**Results to quote**
- 13 Oct, offer viewed: **bureau slowdown first (100%, which is the clamp)**; both Android releases, the iOS 5.2 decoy, the policy change and mix are ruled out. The drop is mostly *abandonment* (+20 pts), matching a slow provider.
- 7 Oct, KYC completed: **Android 2.3 first (100%)**; the KYC API is ruled out (latency was normal).
- 29/30 Sep, offer viewed: policy v2 first (~0.71-0.73).

**Why it's trustworthy-ish:** it makes *testable predictions* (dose-response, cross-platform comparison, replay) rather than just listing events that happened on the same day. The decoy proves it doesn't blame whatever changed today.

**Weaknesses (volunteer these)**
- It's correlation under a modelled counterfactual, **not proof of causation**.
- 100% is a clamp, not certainty; overlapping causes aren't apportioned.
- Within ~14 days after a policy change the baseline partly overlaps the pre-change period, so the policy hypothesis can show a small score on unrelated days (19% "possible" on 5 Oct).
- Only four hypothesis types; provider hypothesis exists only for KYC and offer steps; no interaction effects; no multiple-testing correction.
- Validated only on *my own planted* incidents, so there's a risk of building a method that fits my generator. Real validation needs real incidents with known postmortems.

### 5.3 What-if simulator (`analytics/simulate.js`)

**What:** "If we change the rules, what happens to approvals, disbursals and expected NPA?"

**How**
1. Input: a baseline ruleset (default current) and a candidate (full config, or `{ base: "v2", overrides: {...} }` that may change only a rule's `value`, `op`, `onFail`, plus pricing and the loan multiple). Validated; bad input is a 400.
2. Population: applicants who completed KYC in the window; score used = `bureau_score_latent` (so applicants who abandoned before the bureau answered are still scored, as if it had answered).
3. Each applicant is run through prescreen then credit rules under both rulesets using the real `evaluate`.
4. **Expected disbursals** = sum over approved of P(accept | rate, was the amount cut) x 0.93. P(accept) comes from a table built from offers actually shown in the stored data (cells with < 30 offers borrow the nearest cell).
5. **Expected NPA** = sum( P x amount x default_prob ) / sum( P x amount ), i.e. amount-weighted expected default share.
6. Output baseline, candidate, delta, top reason codes, by-segment tables, and a notice.

**Example run:** FOIR hard cap 0.50 -> 0.45 and soft 0.40 -> 0.38 cut approve rate by 2.1 pts and expected NPA from 1.42% to 1.37%: a small risk gain for a larger volume loss. Tests assert **direction only**: identical ruleset -> zero change; tighter FOIR -> fewer approvals and lower NPA; looser score cut-offs -> more approvals and higher NPA.

**Weaknesses:** no behavioural reaction (applicants, pricing response, fraud adaptation); incident-day bureau failures ignored; referrals aren't counted as disbursals; default risk is a hand-set synthetic formula; with real data you'd need reject inference because rejected applicants' outcomes are never observed.

**Why show NPA beside approvals:** the whole point of lending-specific tooling is that conversion and risk move together.

### 5.4 Compliance RAG (`rag/`)

**What:** answer "what does RBI say about X?" from the Digital Lending Directions, with citations.

**Ingestion (`ingest.js`)**: extract text (`pdftotext -layout`, else the `pdf-parse` package) -> **clean** the diagonal "Withdrawn" watermark, which text extraction scatters as fragments ("ithdr", "aw"...) and page numbers/footers -> **chunk by clause and sub-paragraph** (`Clause 10, para (i)`) -> store in `rag_chunks` with a generated `tsvector` and a GIN index. Idempotent.

**Retrieval (`search.js`)**: `websearch_to_tsquery` parses the question (stop words, stemming), terms are **OR-ed** so a natural question matches; Postgres FTS finds candidate chunks; **BM25** (k1 = 1.2, b = 0.75, IDF computed from the stored corpus) re-ranks them. Heading words are weighted more than body words.

**Answering (`answer.js`)**: take the top chunks (max 3, each at least half the best score), quote them verbatim with `Clause N, para (x)` labels. If the best score < **0.35** return **"Not found in the Directions"** with rephrasing hints. Every answer carries a notice: the source is RBI/2025-26/36 (8 May 2025), the PDF is stamped **Withdrawn**, verify what's in force, not legal advice.

**Why extractive, not generative:** in compliance a fluent wrong answer is worse than a quoted paragraph; nothing can be invented, and a reviewer can check the quote.

**Why Postgres FTS, not a vector DB/embeddings:** one document, works offline with no extra service, and I could *measure* it. Embeddings are the natural next step for vocabulary mismatch.

**Measured (20 labelled questions + 6 out-of-scope):**

| Ranker | Hit@1 | Hit@3 |
|---|---|---|
| `ts_rank_cd` (first baseline) | 55% (11/20) | 85% (17/20) |
| **BM25 (default)** | **85% (17/20)** | **90% (18/20)** |

6 of 6 out-of-scope questions refused.

**Say this caveat unprompted:** I chose BM25 and the 0.35 threshold *after seeing results on this same question set* (questions not edited), so the figures are optimistic; 20 questions is tiny (one question = 5 points); and the threshold margin is thin (0.341 for the worst out-of-scope vs 0.361 for the weakest correct). I treat the numbers as a regression guard; a test fails if they drop below floors.

**Known misses:** vocabulary mismatch ("DLG" vs "Default Loss Guarantee"), generic words outranking a specific paragraph; footnotes aren't indexed; the Annex II numeric table is garbled by text extraction; and the source itself is withdrawn (I haven't mapped what superseded it).

### 5.5 Experiments (`experiments/`)

**What:** run an A/B test and produce a ship / hold / stop decision with a brief.

**How**
- **Assignment:** `sha256(unitId|experimentKey)` -> first 4 bytes mod 100 -> compared with cumulative variant weights. Deterministic (same user always same variant), and different experiments split independently. Exactly two variants (control first), weights integers summing to 100.
- **Cohort:** generated on demand with a *known true effect* (e.g. "show the KFS summary above the Accept button": +2 points acceptance), kept separate from the main dataset so the RCA demo stays clean. Synthetic.
- **Analysis:** two-proportion z-test + 95% confidence interval on the primary metric (acceptance or disbursal rate); **SRM check** by chi-square on assignment counts (flag at p < 0.001); **guardrails** with tolerances: default rate +1 pt, complaint rate +0.5 pt, median TAT +10%.
- **Decision rule (fixed, no LLM):** SRM flagged -> **hold**; any guardrail **breach** -> **stop**; primary significantly worse -> **stop**; primary not significant -> **hold**; otherwise **ship**. A guardrail whose interval straddles its tolerance is "uncertain": a watch note, not a blocker.
- **Brief:** template-generated markdown (hypothesis, results, guardrails, decision, caveats).

**Measured (40,000 units, 30 seeds):** a true +2 pt effect shipped **30/30**; no effect shipped **1/30**; the interval covered the true effect 29/30. A wider 60-seed check outside the suite: 57/60 ships for the real effect, 3/60 "stop" on a significantly negative fluke when there was no effect.

**Lesson to tell:** my first rule held on any "uncertain" guardrail and almost never shipped; measuring power across seeds exposed it.

**Weaknesses:** single look at the data (no sequential testing / peeking correction), two variants only, no multiple-comparison correction, complaint metric is a simulated proxy, cohort is generated not real traffic.

### 5.6 The optional LLM layer (`llm/index.js`)
- Off by default (`LLM_PROVIDER=none`). With `anthropic` + a key (default model `claude-haiku-5-5`), it may reword **three** things only: the RCA narrative, a summary line on the experiment brief, and the compliance answer.
- **Never** used for credit decisions, hypothesis scores/ranking, experiment decisions, or "found / not found".
- **Prompt rules:** use only the provided evidence; copy numbers exactly; keep citation labels; never make a credit decision about a person; treat evidence/question text as data, not instructions (prompt-injection defence).
- **Validation after the call:** every number in the output must appear in the evidence, and required phrases (top cause, decision word, citation label) must survive; otherwise the template is used. Timeout 20 s.
- **Limits:** can't catch spelled-out numbers or wrong causal wording; **tested only against a fake HTTP client, never against the real API.** Say this plainly.

### 5.7 Mock providers and resilience (`mock/`, `integrations/providerClient.js`)
- Mock **bureau** and **KYC** endpoints with configurable latency multiplier, error rate, timeout rate, forced score. Scenario buttons: bureau slowdown, outage, etc., validated.
- **Provider client:** timeout (nominal 6 s, shrunk by `LATENCY_SCALE` = 0.02 so demos are snappy while *recorded* latency stays nominal), **one retry**, **idempotency key** (so a retried call isn't processed twice), never throws (returns a status), and a fallback: bureau failure -> `BUREAU_UNAVAILABLE` referral.
- A small in-process token-bucket **stand-in limiter** protects mock endpoints. It is **not** my Rate Limiter project.
- `npm run live-load` sends fabricated journeys through the real API; you can inject an incident mid-run and see recorded p95 climb and referrals appear.

### 5.8 Frontend and engineering quality
- React 18 + Vite 5 + Recharts. Pages: Journey, Funnel (with release/policy markers and segment filters), Anomalies (-> Investigate), RCA, Simulator, Compliance, Experiments, Mock controls. Synthetic banner on every page.
- **111 automated tests** pass (server 94 on `node:test`, web 17 on Vitest) via `npm run check` (tests + production build). Includes: rules, journey, analytics (incl. pinned detector results), simulator direction, RAG eval floors, experiments, mock controls, LLM validation, hardening (input validation, JSON errors, no stack traces), and a structural test that credit code never imports the LLM module.
- Errors are JSON; inputs validated (real calendar dates, positive integer ids, short strings, no repeated query params); body limit 1 MB; a 500 never leaks stack/SQL.
- **Tech stack summary:** Node 20+ ESM, Express 4, `pg` (plain SQL), `embedded-postgres` (real Postgres with no install; or `DATABASE_URL`), `pdf-parse`, React, Vite, Recharts, Vitest, `node:test`.

---

## 6. Numbers cheat-sheet

| Fact | Value |
|---|---|
| Applications / days | 26,879 / 40 (10 Sep - 19 Oct 2026) |
| Disbursal conversion | 18.6% (5,010 loans) |
| Step conversions | KYC 81.8%, prescreen 86.2%, offer 48.8% (weakest), accept 58.1%, disburse 93.3% |
| Rejected / referred (at some point) | 8,244 / 5,370 |
| Detector settings | 14-day median baseline, >= 7 days history, z <= -3, drop >= 3 pts, MAD x 1.4826, binomial SE floor |
| Flagged | 6 (5 planted + 1 chance: 5 Oct, z = -4.2) |
| RCA thresholds | wait > 1.2 x baseline p95; significance z >= 2.5; >= 30 today / >= 100 baseline; verdicts 0.5 / 0.15 |
| Rules v1 -> v2 | FOIR hard 55% -> 50% (soft 45% -> 40%) from 29 Sep 2026 |
| Other rules | age 21-60; income >= ₹25,000; score hard 650, soft 700; max loan 15x income |
| Pricing | 750+: 11%; 700+: 13%; else 16% |
| Simulator example | approve rate -2.1 pts; expected NPA 1.42% -> 1.37%; disbursal rate 0.93 |
| RAG | BM25 hit@1 85%, hit@3 90% (20 Qs); first baseline 55% / 85%; 6/6 out-of-scope refused; refusal threshold 0.35 |
| Experiments | 40k units, 30 seeds: +2 pt effect ships 30/30; no effect 1/30; CI covers 29/30; SRM p < 0.001 |
| Guardrail tolerances | default +1 pt; complaints +0.5 pt; TAT +10% |
| Tests | 111 (94 server + 17 web) |
| Loader speed | 56 s -> 0.84 s |

---

## 7. Honest limitations (say these before they ask)

1. **Synthetic data.** Detection working on invented stories shows the *method* works, not that it would on a real lender. Effects are what my generator put in.
2. **Feature correlations are simplified** and default risk is hand-set, so absolute NPA is illustrative.
3. **Detector:** one chance false alarm; day-level granularity.
4. **RCA:** correlation under a counterfactual model, not causation; baseline-overlap artefact after policy changes; validated on my own planted incidents.
5. **Simulator:** no behavioural response; needs reject inference on real data.
6. **Compliance:** lexical retrieval; optimistic eval (tuned on the same 20 questions); source stamped **Withdrawn**; not legal advice.
7. **Experiments:** single look, two variants, simulated cohort and complaint proxy.
8. **LLM path never run against the real API.**
9. **Prototype scope:** no authentication (the reseed and rules endpoints are open, so it's local-only), no end-to-end browser tests, no accessibility audit, mock state in process memory, `embedded-postgres` unpinned ("latest").
10. **No fairness audit:** rules use age and employment type; a real lender would test for disparate impact and RBI Fair Practices compliance.

---

## 8. Twisted questions (with answers)

### Framing and product
**Q: Isn't this just a dashboard?**
A: "A dashboard shows what happened. The RCA tests causes with counterfactuals (dose-response, cross-platform comparison, ruleset replay), the simulator answers 'what if' by replaying real applicants through new rules, and the compliance tab refuses to answer when the text doesn't support it. The charts are the surface."

**Q: How is it different from Mixpanel / Datadog / a vendor LOS?**
A: "Each covers one box: funnels, API health, decisioning. None connects a conversion drop to provider latency, releases and policy changes, or shows conversion beside credit risk. I don't claim depth over any of them; the claim is integration of the decision loop."

**Q: Did you see this problem in real life?**
A: "No; I haven't worked at a lender. I derived it from how digital-lending PM teams operate and from the role description, and I kept the claims modest for that reason."

**Q: Who would use it, and how would you validate demand?**
A: "A lending PM first. I'd interview PMs, analysts and risk people about the last conversion drop: how long diagnosis took, which tools, who was involved. Success would be time from 'conversion dropped' to 'ranked cause with evidence' under an hour, fewer reversed decisions after experiments, and every compliance statement traceable to a clause. None of that is measured here."

**Q: What would you build next?**
A: "(1) Real validation: get an anonymised funnel and a few past incidents with known postmortems. (2) Calibrate default behaviour on repayment data with reject inference. (3) Sequential testing in experiments. (4) Refresh the regulatory corpus from the current instruction. (5) Auth and an audit trail so rule changes are approved, not just made."

**Q: Why those five modules and not others? What did you cut?**
A: "They map one-to-one to the PM's decision loop. I cut authentication, real integrations, an ML credit model, collections and multi-tenancy; they don't test the idea. I also dropped Redis/queues, since nothing in the loop needs them."

**Q: Is optimising conversion even the right goal for a lender?**
A: "Not alone. That's why the north star is tied to guardrails: NPA, TAT and complaints. A conversion gain that raises bad loans is a loss, and the simulator shows both together."

### Data
**Q: Why synthetic data? Isn't it circular?**
A: "Real lender data is confidential. The risk of circularity is real: my generator puts in the effects my detector finds. So I only claim the method works on known answers, I included a decoy and a chance false alarm to test for over-fitting, and I list what real validation would need."

**Q: Is the data realistic?**
A: "Partly. Distributions are plausible (right-skewed income, amounts scaled to income, rules enforced via the same engine), but features like score and income are independent and default coefficients are hand-set, so absolute NPA is illustrative. I'd calibrate on public Indian benchmarks and a fitted default model if I extended it."

**Q: What's the 'synthetic advantage'?**
A: "I generate every applicant, so I know who would default even if rejected. A real lender never observes that for rejected applicants. It makes the simulator's NPA look more knowable than it would be."

### Detector
**Q: Why z <= -3 and 3 points? Why 14 days?**
A: "z = -3 is a conventional 'unlikely under noise' line; the 3-point floor is a practical-significance filter; 14 days covers two weekly cycles but adapts to level shifts. They're defaults I set and tested against known incidents, not tuned optima, and they're configurable."

**Q: You have a false alarm. Why should I trust it?**
A: "Over about 40 days x 5 steps, a few z = -3 events are expected by chance, and I'd rather show that than hide it. In practice you'd treat flags as triage: the RCA then says whether any hypothesis explains it. A flag with no supported cause is likely noise."

**Q: Why not ML anomaly detection?**
A: "No training history, and a PM needs to see why it fired. A robust baseline with a stated threshold is explainable. ML makes sense with long history and seasonality."

**Q: What if the incident is short (8 hours)?**
A: "Daily aggregation dilutes it: 13 Oct only just trips the threshold. Next step is hourly detection with a seasonality-aware baseline, which also needs enough volume per hour."

### RCA
**Q: How do you know the RCA is right?**
A: "On real data I wouldn't know without postmortems. Here I know the planted truth: it ranks the bureau slowdown first on 13 Oct, Android 2.3 first on 7 Oct, rules out the decoy, and attributes 29-30 Sep to the policy. That shows the method can separate causes, not that it's right everywhere."

**Q: Why does the bureau show 100%? Is that certainty?**
A: "No, it's the clamp at 1. The raw counterfactual can exceed 1 when the 'unaffected' group converts higher than the baseline. Treat it as 'explains essentially all'."

**Q: What if two causes happen at once?**
A: "Scores are independent counterfactuals so both can be 'likely', and they may overlap. It doesn't apportion shares between interacting causes. That's a stated limitation."

**Q: Why did a decoy release get zero?**
A: "Users on iOS 5.2 converted about as expected given the other platforms' movement (difference-in-differences), so there's no residual to attribute."

**Q: Correlation vs causation?**
A: "I use causal-style designs (dose-response, comparison group, counterfactual replay) which are stronger than raw correlation, but they're observational. Confirmation would be a rollback or an experiment, which is why the experiment module exists."

### Rules and lending
**Q: Why deterministic rules instead of ML/LLM decisions?**
A: "Credit decisions need to be explainable, reproducible and auditable, with reason codes the borrower can be given. Models drift and LLMs can invent facts. An LLM here may only reword text, and a test enforces that the credit code never imports it."

**Q: Why refer, not reject, when the bureau fails?**
A: "A provider outage isn't the applicant's fault. Rejecting would punish them; approving blindly would take unpriced risk. Referral sends them to a human with the reason `BUREAU_UNAVAILABLE`."

**Q: What is idempotency and why use it?**
A: "A retry key so a repeated request isn't processed twice, so a retried bureau or KYC call after a timeout doesn't double-act."

**Q: Why pull the bureau after prescreen?**
A: "Bureau pulls cost money and leave an enquiry on the applicant's file, so don't do them for people who fail basic age/income rules."

**Q: Is your APR / cooling-off right?**
A: "APR is an illustrative monthly-IRR x 12 calculation, not RBI's prescribed method, and the 3-day cooling-off is an illustrative lender value. I'd check both against the current Directions before claiming compliance."

**Q: Fairness and privacy?**
A: "Rules use age and employment type; I haven't done a fairness or disparate-impact audit, and with real data I'd need consent, data minimisation and PII controls. Synthetic data avoids the issue for now but I'd list it as a prerequisite for real use."

### RAG
**Q: Why not embeddings / a vector DB / an LLM answer?**
A: "One document, offline, measurable, and no hallucination risk. The cost is vocabulary mismatch ('DLG'), which embeddings or query expansion would help."

**Q: How good is it really?**
A: "85% hit@1 and 90% hit@3 on 20 questions, 6/6 refusals, but I tuned the ranker and threshold on that same set, so it's optimistic. One question is 5 points. I use it as a regression guard."

**Q: The PDF is withdrawn. Why use it?**
A: "It's the document I had. Every answer says it's stamped Withdrawn and to verify what's in force. A production version needs a corpus refresh process with an owner."

### Experiments / statistics
**Q: What is SRM and why does it block shipping?**
A: "If the observed split differs from the configured one (chi-square p < 0.001), something is wrong with assignment or logging, e.g. users dropped from one arm. Results can't be trusted, so the decision is hold."

**Q: Why those guardrails?**
A: "Lending-specific harms: default rate (risk), TAT (speed promise), complaints (customer harm). They're tolerance-based, so a gain that breaches one is a stop."

**Q: Peeking / multiple testing?**
A: "One look, fixed rule, no correction; stated limitation. With real data I'd pre-register metrics and use fixed-horizon or sequential tests."

**Q: Why does your experiment prove anything if you simulated the effect?**
A: "It doesn't prove a business result. It tests the decision machinery: with a known +2 pt effect it ships 30/30; with none, 1/30."

### Engineering
**Q: What breaks at scale?**
A: "Loading all application rows into memory (fine at 27k, not millions): I'd push aggregation into SQL or materialised daily aggregates, use a warehouse like ClickHouse/BigQuery for events, and stream events. Also: no auth, open admin endpoints, in-process mock state."

**Q: Why Node and not Python?**
A: "One language across API, analytics and tooling. For serious statistics or modelling I'd move analysis to Python."

**Q: Hardest bug / biggest lesson?**
A: "The loader took 56 s from a per-row subquery; one aggregation pass fixed it (0.84 s). Also the first RAG ranker (55% hit@1) and an over-strict experiment rule, both found by measuring."

**Q: How did you test it?**
A: "111 automated tests, plus planted scenarios with known answers, an eval set for retrieval, and multi-seed runs for the experiment rule. Some figures are measured once and not pinned; a claims audit lists which."

**Q: Did you write all the code yourself? How did you use AI?**
A: "Be factual: I defined the problem, scope, metrics, guardrails and design rules, directed the build with a written spec, used an AI coding agent to write and test much of the code, and reviewed behaviour with tests and a claims audit. I can walk through any module and I'm clear on what is and isn't validated." (Don't claim you hand-wrote it; don't downplay that you made the product decisions.)

**Q: Is this production-ready?**
A: "No. Prototype on synthetic data: no auth, no real integrations, no end-to-end browser tests, unverified real LLM path."

**Q: What if the demo fails?**
A: "Backup: show the README, the measured results table, and the RCA evidence text. Known first-run delay: seeding takes about a minute; run `npm run dev` ahead of time."

---

## 9. Traps: do NOT claim

- That Rate Limiter or TaskForge are integrated (they aren't).
- That any figure is real-world, calibrated, or from a real lender.
- That the LLM works against the live API (only a fake client was tested).
- That RAG accuracy is "85%" without the tuned-on-the-same-set caveat.
- That the RCA proves causation, or that "100%" means certainty.
- That the PDF is current law (it's stamped Withdrawn) or that this is legal advice.
- That it uses Redis, a job queue, vector DB, ML scoring, or authentication (none exist).
- That you've worked at a lender or measured business impact.

## 10. Last-10-minutes checklist
- Say the 60-second pitch out loud once.
- Recite: 18.6% north star, weakest step 48.8%, 6 flags (5 + 1 chance), bureau first on 13 Oct, decoy ruled out, FOIR 55% -> 50%, hit@1 85% (tuned on same set), 111 tests.
- Recite the three design ideas: pure functions over rows; rules decide, LLM only words; safe fallbacks.
- Recite the three things you'll volunteer: synthetic data, correlation not causation, LLM path untested.
- For every "why" question, answer in the shape: **need -> choice -> trade-off -> what I'd do with more time.**
