# LoanLens: Product Requirements

> **Synthetic data.** LoanLens is a portfolio prototype built on generated data. It is not a real lending system and not legal advice. Figures quoted here are measurements from this repository's synthetic dataset.

## 1. Problem

A product manager at a digital lender watches a funnel: apply, KYC, eligibility, offer, accept, disburse. When conversion drops, four questions follow:

1. **Where** did it drop?
2. **Why?** (An app release? A slow bureau? A credit-policy change? A different mix of applicants?)
3. **What can we change** without raising bad loans?
4. **Is that change allowed** under RBI's digital lending rules?

Each answer sits in a different tool (product analytics, API monitoring, the rules console, a PDF of regulations), owned by different teams. The PM chases analysts, engineers and the risk team, so a one-day incident takes days to diagnose, and the fix is then argued without evidence.

## 2. Users

| User | Needs | Uses LoanLens to |
|---|---|---|
| **Lending product manager (primary)** | Fast, defensible answers to the four questions; a decision they can take to risk and engineering | Spot a drop, see ranked causes, try a rule change, check the rule against the Directions, run and read an experiment |
| Risk analyst (reviewer) | See the credit-risk cost of any conversion fix, next to the conversion gain | Review simulator output (expected NPA beside approvals) |
| Compliance officer (reviewer) | See which clause a statement rests on and how sure the system is | Check citations and the "Withdrawn source" notice before relying on an answer |
| Engineer / SRE (reviewer) | Know whether a provider slowdown or a release caused the drop | Read the RCA evidence (hourly provider latency, release difference-in-differences) |

## 3. Goals

1. **Detect** step-conversion drops automatically, with a stated and tested false-alarm behaviour.
2. **Diagnose** by ranking causes with evidence a reviewer can check, and by ruling things out (for example a release that changed nothing).
3. **Decide** with a what-if simulator that always shows conversion and expected NPA together.
4. **Check** compliance with cited answers, a visible refusal when the text does not support an answer, and a standing warning about the source's status.
5. **Experiment** with a framework that refuses to ship on bad data (sample-ratio mismatch) or on a breached guardrail.
6. Keep every credit decision **deterministic and explainable** (reason codes), and keep any language model out of decisions.

## 4. Non-goals

- Not a production loan origination system, bureau/KYC integration, collections or servicing tool.
- No real borrower data, authentication, or multi-tenant features.
- No claim of legal or regulatory advice; the compliance tab is a retrieval aid over one document.
- No machine-learning credit model. The scorecard is rules; the default probability in the data is a hand-set synthetic formula.
- No automatic action on the PM's behalf: nothing changes rules or ships an experiment by itself.
- Not integrated with the author's other projects (Rate Limiter, TaskForge). The mock providers use a small in-process stand-in limiter only.

## 5. User stories and where they live

| # | Story | Acceptance | Built in |
|---|---|---|---|
| 1 | As a PM I see the funnel by day, with releases and policy changes marked, filterable by device, channel, employment, new-to-credit and app version | Funnel tab renders; markers appear inside the window; segment filter changes the numbers | `analytics/funnel.js`, `web/.../Funnel.jsx` |
| 2 | As a PM I am told which days look abnormal, and how sure the system is | `/api/anomalies` returns day, step, rate, baseline, z; UI says some flags are chance | `analytics/anomaly.js` |
| 3 | As a PM I click an anomaly and see ranked causes with evidence, plus what was ruled out | Hypotheses sorted by counterfactual score; each has evidence lines; caveat text always shown | `analytics/rca.js` |
| 4 | As a PM I try a rule change and see approvals, expected disbursals and expected NPA, with the caveats | Identical ruleset gives zero change; tighter FOIR lowers approvals and NPA; invalid input gives a 400 with a message | `analytics/simulate.js` |
| 5 | As a PM I ask a compliance question and get quoted clauses, or "Not found" | Citations as `Clause N, para (x)`; notice on every answer; out-of-scope questions refused | `rag/` |
| 6 | As a PM I define an experiment, run it on a simulated cohort and get a decision with a brief | Ship only if the primary metric is significant and no guardrail is breached; SRM blocks; brief is generated | `experiments/` |
| 7 | As an engineer I can inject a bureau slowdown or outage and watch the funnel and `BUREAU_UNAVAILABLE` referrals respond | Scenario buttons and sliders validated; recorded-calls table updates | `mock/controls.js`, `scripts/live-load.js` |
| 8 | As an applicant (demo) I can complete a journey, see a Key Fact Statement before accepting, and receive reason codes if referred or rejected | Journey page locks later steps until earlier ones pass | `journey/`, `rules/kfs.js` |
| 9 | As a reviewer I can see wording from a language model only when it is safe | Output with a changed or invented number is discarded | `llm/index.js` |

## 6. Success metrics

For a prototype the measures are about whether the method works on known answers, not about business impact.

| Metric | Result so far (synthetic data) | How measured |
|---|---|---|
| Planted incidents detected | 5 of 5 planted story-days flagged (29 Sep, 6, 7, 8, 13 Oct) | Run `/api/anomalies` on the seeded data |
| False alarms | 1 flag with no cause of its own (5 Oct, in the week after the policy change) among 6; 0 daily flags outside that window across 8 re-rolled datasets | Same run; `scripts/evaluate-detector.mjs` |
| Lasting shifts | Daily detector found the policy change in 2 of 8 re-rolled datasets; the sustained-shift detector in 7 of 8 (settings tuned on those 8) | `scripts/evaluate-detector.mjs` |
| RCA ranks the true cause first | Yes for 13 Oct (bureau slowdown) and 7 Oct (Android 2.3); decoy iOS release ruled out | Analytics tests and manual runs |
| Compliance retrieval | Clause hit@1 85%, hit@3 90% on 20 questions; 6 of 6 out-of-scope refused. Optimistic: ranker tuned on the same set | `docs/RAG_EVAL.md` |
| Experiment decision quality | +2 pt effect: ships 30 of 30; no effect: ships 1 of 30 | `experiments.test.js`, 40,000 units |
| Regression safety | 131 automated tests passing (109 server, 22 web) plus a 170-check evaluation harness | `npm test`, `scripts/evaluate.mjs` |

What would count as success with real data: time from "conversion dropped" to "ranked cause with evidence" under an hour; fewer reversed decisions after experiments; every compliance statement traceable to a clause. None of these is measured here.

## 7. Risks and how the design handles them

| Risk | Mitigation | Residual risk |
|---|---|---|
| **Spurious causes**: correlated events look causal | Each hypothesis is scored by a counterfactual (what would the rate have been without it), releases are compared against other platforms, a decoy release is in the test data, and the UI states that scores are not proof of causation | Scores can overlap; a policy change still shows a small score for about 14 days afterwards |
| **Detector noise** | Needs both a robust z of -3 or worse and a 3-point drop; binomial standard error floors the spread on small days | One flag with no cause of its own in 40 days of data; a lasting few-point shift is caught by a second, sustained-shift detector (tuned on 8 datasets) |
| **Compliance answer is wrong or stale** | Extractive quotes with citations, refusal below a tuned threshold, and a permanent notice that the PDF is stamped Withdrawn and this is not legal advice | Lexical retrieval misses synonyms; the source may be superseded; eval figures are optimistic |
| **Language model invents numbers or makes decisions** | Optional and off by default; phrasing only; outputs validated against the evidence; fallback to templates | Spelled-out numbers and wrong causal wording are not caught; real API path untested |
| **Simulator overstates the benefit** | Always shows NPA beside approvals; notice that default risk is a synthetic ground truth and no behavioural reaction is modelled | Real default labels exist only for approved loans, so this needs a reject-inference method on real data |
| **Peeking and false positives in experiments** | Fixed decision rule, SRM check, guardrails | Single look, no sequential correction; documented in every brief |
| **Looks like a real product** | Synthetic banner on every page, `synthetic: true` in responses, this document | A screenshot cropped of the banner could mislead; the docs say so |

## 8. Open questions for a real deployment

- Where do real default labels come from, and how are rejected applicants handled (reject inference)?
- Which regulation text is currently in force, and who owns refreshing the corpus?
- Which events does the real funnel emit, and how are bots, retries and duplicate applications treated?
- Who approves a rule change suggested by the simulator, and where is it versioned?
