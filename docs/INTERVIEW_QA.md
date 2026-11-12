# LoanLens: interview questions and answers

> **Synthetic data.** Every result below is on generated data. Answers point to the code that backs them so you can open it while talking. Quote numbers only as "measured on the synthetic dataset".

**30-second version.** "LoanLens is a workbench for a digital-lending PM. It detects a conversion drop, ranks the likely causes with counterfactual scores, replays applications through a candidate rule change to show conversion next to expected NPA, answers RBI-compliance questions with clause citations, and runs A/B experiments with guardrails. Credit decisions come from a deterministic rules engine; a language model is optional and can only reword text. It runs on synthetic data with four planted incidents so the method can be checked against known answers."

## A. Product and framing

**1. Who is the user and what problem does it solve?**
A lending PM. Today the answers to "where, why, what, allowed, did it work" live in separate tools and teams. LoanLens puts them in one loop: detect, diagnose, decide, check, experiment (`docs/PRD.md`).

**2. How is this different from Mixpanel, Datadog or a BRE console?**
Each of those covers one box. LoanLens joins them with lending specifics: provider dependencies (bureau, KYC), reason codes, FOIR, expected NPA beside conversion, and RBI citations. It is a prototype, so the claim is about integration of ideas, not depth.

**3. What is the north-star metric and why?**
Application-to-disbursal conversion (18.6% on the synthetic data), as the product of five step conversions. Guardrails are NPA, turnaround time and complaints (`docs/METRIC_TREE.md`). A conversion gain that raises NPA is not a gain, which is why the simulator shows both.

**4. What would you build next with real data?**
Calibrate default behaviour on real repayment data with reject inference; replace the synthetic funnel with the real event stream; add sequential testing to experiments; and have risk and compliance review the rule suggestions. See also Q30.

## B. Decisioning and rules

**5. Why a deterministic rules engine and not an ML or LLM decision?**
Credit decisions must be explainable, reproducible and auditable, and a borrower is owed reasons. `rules/engine.js` evaluates JSON rules, gives reject > refer > approve, and returns reason codes for each triggered rule. A model can drift, hallucinate and cannot easily cite why. An LLM here is restricted to wording (Q26).

**6. How are rules versioned and changed?**
Rulesets are JSON rows in `rule_versions` with an `effective_from`. v1 caps FOIR at 55%; v2 at 50% from 29 Sep 2026. The journey uses the ruleset in force at the time, and the RCA and simulator can replay past applicants under any version. Changing rules needs no redeploy.

**7. What does "refer" mean and when does it fire?**
A manual-review outcome for borderline cases (score 650 to 699, FOIR between the soft and hard cap) and for missing data. If the bureau fails after the timeout and one retry, the engine sees a missing score and refers with `BUREAU_UNAVAILABLE`, so a provider outage turns into reviews, not into failed applications and not into blind approvals (`integrations/providerClient.js`, `rules/engine.js`).

**8. Explain FOIR and why it is in the rules.**
Fixed obligations to income: (existing EMI + new EMI) / monthly income. It caps over-leveraging. In the data the policy change from 55% to 50% creates a step change in rejections, which the RCA must tell apart from a dip caused by an incident.

## C. Detection

**9. How does the anomaly detector work?**
For each step and day, the baseline is the median of the previous 14 days' conversion (at least 7 days). The spread is the larger of the baseline's MAD (x 1.4826) and the binomial standard error for the day's volume. A day is flagged if z <= -3 and the drop is at least 3 points (`analytics/anomaly.js`).

**10. What is its false-positive rate?**
On the shipped 40-day dataset it flags six day-steps: five are planted (29 Sep, 6, 7, 8 and 13 Oct) and one, 5 Oct, has no cause of its own: it is a 4-sigma flag six days after the policy change, so it may be partly the same lasting effect. One draw is a poor basis for a rate, so I re-rolled the generator: over 8 draws the detector found the Android and bureau incidents every time and raised no flag outside the policy-change window. But it found the policy change itself in only 2 of 8, because a lasting few-point drop hides in daily noise. That is why there is a second, sustained-shift detector (4-day pooled window against the 14 days before); it found the policy change in 7 of 8 with no unexplained episodes, with the caveat that its settings were chosen on those same draws.

**11. Why both a z-score and a minimum drop?**
The z-score says it is unlikely to be noise; the 3-point floor says it matters. With large daily volumes a tiny, real wobble can have a big z but no business meaning.

**12. Why median and MAD rather than mean and standard deviation?**
They are robust to the incident days already in the window; a past outage should not inflate the baseline or the spread.

**13. The policy change on 29 Sep is flagged. Is that an anomaly?**
It is flagged as a drop at "offer viewed" (z = -3.4) and the RCA ranks the policy change first (score 0.71, "likely") with the bureau, the web release and traffic mix ruled out. It is a real, intended shift, which is why the funnel marks policy changes and the RCA has a rule-change hypothesis.

## D. Root-cause analysis

**14. How does the RCA avoid blaming the wrong thing?**
Every hypothesis gets an independent counterfactual: the share of the drop that would disappear without that cause. Provider latency uses a dose-response check (applicants who waited longer than 1.2 x the baseline 95th percentile converted less, and the difference is significant). A release compares its platform's change against other platforms (difference-in-differences) so a market-wide dip is not blamed on a release. A policy change replays today's applicants under the previous ruleset. A mix hypothesis re-weights the baseline by today's mix (`analytics/rca.js`).

**15. What is the decoy?**
An iOS 5.2 copy release on the morning of 13 Oct, the same day as the bureau slowdown. A naive "what changed today" answer blames it. The RCA gives it zero and marks it ruled out, because iOS users on the new build did not convert worse than expected.

**16. Are the scores probabilities?**
No. They are shares of the drop explained under a model, clamped to 0 to 1, and they can overlap, so they need not sum to 1. The page says it is correlation under a modelled counterfactual, not proof.

**17. Known weaknesses of the RCA?**
Within about 14 days after a policy change the baseline overlaps the pre-change period, so the policy hypothesis can show a small score for unrelated days (19% "possible" on 5 Oct). A shared shock can also hit one platform harder by chance and make a release look guilty, so a release whose notes name a different step has its score halved; that reduces the problem but does not remove it. On a day whose change is within noise the RCA now scores nothing instead of crediting a cause with a share of a tiny drop. Only a few hypothesis types exist, and only offers and KYC have a provider hypothesis. It also needs enough volume (30 applications that day, 100 in the baseline).

**18. Does the LLM do the RCA?**
No. Scores, ranking and evidence come from code. The narrative is a template; with a key, a model may reword it, and its numbers are checked against the evidence.

## E. Simulator

**19. How does the what-if simulator work and what can it not do?**
It takes applicants who completed KYC in a window, runs the existing `evaluate` under baseline and candidate rulesets, and reports decision mix, expected disbursals (P(accept) x 0.93, where P(accept) is estimated from stored offers by rate and amount cut) and expected NPA. It does not model behaviour change, ignores bureau outages in the replayed data, and does not count referrals as disbursals (`analytics/simulate.js`).

**20. Where does "would default" come from and why is it a problem?**
The generator invents applicants, so it knows each one's default probability. Real lenders never observe that for rejected applicants (selection bias). So expected NPA here is a synthetic advantage. With real data you need reject inference or a holdout policy.

**21. Is the simulator's result believable?**
Directionally. Tests assert direction only (tighter FOIR means fewer approvals and lower NPA; looser cut-offs raise both). One run: FOIR cap 0.50 to 0.45 and soft cap 0.40 to 0.38 cut the approve rate by 2.1 points and expected NPA from 1.42% to 1.37%, a small risk gain for a larger volume loss. The absolute NPA level comes from a hand-set formula, so do not read it as realistic.

## F. Compliance RAG

**22. Why extractive answers instead of a generated answer?**
In compliance a fluent wrong answer is worse than a quoted paragraph. The answer is the stored text with `Clause N, para (x)` citations; nothing is invented. Retrieval below a score threshold returns "Not found" instead of guessing. The PDF is also stamped "Withdrawn", so every answer carries a notice (`rag/answer.js`).

**23. How does retrieval work and how well does it do?**
Postgres full-text candidates (OR-ed `websearch_to_tsquery` terms, GIN index), re-ranked with BM25 using IDF computed in JS. On 20 labelled questions: clause hit@1 85%, hit@3 90%, and 6 of 6 out-of-scope questions refused. The first `ts_rank_cd` baseline gave 55% and 85%.

**24. Can you trust those numbers?**
Not fully. I added BM25 and set the 0.35 threshold after seeing the baseline results on the same set (the questions were not changed). So they are optimistic, twenty questions is a tiny sample (one question = 5 points), and the threshold margin is thin (0.341 for the worst out-of-scope question vs 0.361 for the weakest correct one). I use them as a regression guard, and the test fails if they drop below floors (`rag.test.js`, `docs/RAG_EVAL.md`).

**25. What does it miss and why?**
Vocabulary mismatch: the Directions spell out "Default Loss Guarantee" while a question says "DLG", and generic words can outrank a specific paragraph. Embeddings or query expansion would help; I did not add a synonym list because that would be tuning to this question set.

## G. LLM

**26. Where is the LLM used and where is it not?**
Optional (`LLM_PROVIDER=anthropic` plus a key). It can reword the RCA narrative, add a summary line to the experiment brief and rewrite a compliance answer. It is never used for credit decisions, hypothesis scores, experiment decisions, or deciding whether something is found. The app is complete without it.

**27. How do you stop it making things up?**
Strict prompt (use only the evidence, copy numbers, keep citations, treat evidence as data) and then validation: every number in the output must appear in the evidence and required text (the top cause, the decision word, a citation label) must survive, else the template is used (`llm/index.js`). Limits: it cannot catch spelled-out numbers or wrong causal wording, and I have only tested it against a fake HTTP client, not the real API.

## H. Experiments

**28. How are experiments assigned and analysed?**
Assignment is `sha256(unitId|key)` mod 100 against the variant weights, so the same unit always gets the same variant and different experiments split independently. Analysis is a two-proportion z-test with a 95% interval, a chi-square sample-ratio check (flagged at p < 0.001), and guardrail intervals against tolerances (`experiments/`).

**29. What is the decision rule and what is its measured behaviour?**
SRM flagged: hold. Any guardrail breach: stop. Primary significantly worse: stop. Primary not significant: hold. Otherwise ship; an "uncertain" guardrail only adds a watch note. At 40,000 units over 30 seeds, a true +2 point effect shipped 30 of 30, no effect shipped 1 of 30, and the interval covered the truth 29 of 30. In a wider 60-seed check, a real effect was missed 3 times and noise produced 3 "stop" decisions. My first draft held on "uncertain" guardrails and nearly never shipped, which taught me to measure power across seeds.

**30. What are the limits, and what would you do with real data?**
Single look (no sequential testing), two variants, one primary metric, simulated complaint proxy, cohorts generated with a known effect. With real data: pre-register metrics, add CUPED or stratification, use sequential or fixed-horizon plans, monitor SRM continuously, and use real complaint data. For the whole project: calibrate defaults on repayment data, handle reject inference, connect the real event stream, refresh the regulatory corpus from the current instruction, and add authentication and an audit trail.

## Extra questions to be ready for

**What did you get wrong along the way?** The first RAG ranker was weak (55% hit@1); my first experiment rule was too strict; the analytics loader took 56 s because of a per-row subquery (now 0.84 s after one pass of aggregation); and the simulator once labelled an unchanged baseline "v2+overrides". All are fixed and have tests.

**How do you know your retrieval numbers are not just tuned to your test set?** I did not, so I wrote a second set of 20 questions after the design was fixed and never tuned on it. Ranking held (85% hit@1 and 90% hit@3 on both sets, against 25% and 60% for the first ranker on the new set), but refusal did not: 4 of 6 unrelated questions were refused on the new set versus 6 of 6 on the tuned one. Words like "tenure" and "capital" occur in the Directions, and lexical search cannot see the topic is different. I tried a two-term rule, it traded one error for another, and I left it out.

**What does an experiment that says "hold" tell you?** Less than it seems. The analysis now reports the minimum detectable effect (about 1.4 points at 40,000 users): a hold on a test that could not have seen a 1-point effect is not evidence of none. Over 150 repeats, a true +1 point effect shipped only 48% of the time, +2 points 97%, and no effect stopped 4% of the time on a fluke or a chance guardrail breach.

**What did you find when you evaluated your own system?** A race (three parallel offer requests wrote three events and made three bureau calls), RCA scores of 100% on a day that moved 0.1 points, an API that returned the synthetic default probability to the applicant, a language-model check that a digit-free invented claim could pass, and a detector that missed the policy change in most re-rolled datasets. All are fixed or documented in `docs/IMPROVEMENT_LOOPS.md`.

**Is it production-ready?** No. No authentication, in-process mock state, no end-to-end browser test, synthetic data only, and the real LLM path is untested.

**How did you use AI to build it?** Be factual: say which parts you reviewed and tested; the spec, tests and `docs/PROGRESS.md` record decisions and failures.

**Rate limiter / TaskForge?** Separate projects. LoanLens only has a small in-process token-bucket stand-in in front of its mock providers.
