# LoanLens: 5-minute demo script

> **Synthetic data.** Say this first and point at the banner: "Everything here is generated. It is a prototype, not a lending system."

**Setup (before the call):** `npm run dev`, wait until <http://localhost:5173> loads (first run seeds the data, about a minute). Have the dev database in its normal state (`POST /api/admin/reseed` resets it). Use the dark or light theme, whichever reads better on the screen you share.

**The one-sentence story:** "A PM's conversion dropped; LoanLens tells them where, why, what to change, whether it is allowed, and how to test it."

| Time | Tab | Story |
|---|---|---|
| 0:00 | Journey | The product behind the data |
| 0:45 | Funnel | Where is the funnel weak? |
| 1:30 | Anomalies and RCA | What broke on 13 Oct, and what did not? |
| 2:45 | Simulator | What if we change the rules? |
| 3:30 | Compliance | Can we say that? |
| 4:15 | Experiments | Did the fix work? |
| 4:45 | Mock controls | Break it live (optional) |

## 1. Journey (0:00 to 0:45): "a lender with deterministic rules"
1. Open **Journey**, click **Start application**, then walk KYC, eligibility, **Get offer**.
2. Point at the **Key Fact Statement** (rate, APR, fees, EMI, cooling-off days, grievance officer) shown before **Accept offer**.
3. Say: "The decision comes from a versioned rules engine with reason codes, not from a model. If the bureau times out, the application is referred with `BUREAU_UNAVAILABLE` rather than failing."
4. If you get a referral or rejection, show the reason codes; it is a feature.

## 2. Funnel (0:45 to 1:30): "where"
1. **Workbench > Funnel.** Show daily step conversion over the 40 days. Click legend entries to isolate a line.
2. Point at the amber dashed lines (app releases) and the purple one (credit policy v2 on 29 Sep).
3. Note the dip in KYC completion on 6 to 8 Oct (Android only: use **Filter by > Device > android** to show it disappears on iOS and web).
4. Say: "Overall disbursal conversion is 18.6%; the weakest step is eligibility to offer at 48.8%."

## 3. Anomalies and RCA (1:30 to 2:45): "why" (the centrepiece)
1. **Workbench > Anomalies.** Six flagged day-steps. Say: "Five are planted incidents; one, 5 Oct, has no cause of its own: it is six days after the policy change, so it is a chance flag that may be partly the same lasting effect. The detector flags a day when its conversion is at least 3 robust standard deviations below the 14-day median and at least 3 points lower." Then point at **Sustained shifts** underneath: "A second detector pools four days to catch a lasting shift too shallow for one day to stand out. It finds the policy change (29 Sep to 5 Oct) and the Android regression. Over eight re-rolled datasets it found the policy change in seven, but its settings were tuned on those same datasets."
   Try the page on a phone-sized window too: the tabs scroll sideways, tables scroll inside their cards, and nothing spills off the screen.
2. Click **Investigate** on **13 Oct, offer viewed**.
3. Show the ranking: **bureau API slowdown first, 100%**, with the hourly latency chart spiking 11:00 to 19:00 IST. Then the others: Android releases, the **iOS 5.2 release that morning (ruled out)**, the policy change (ruled out), traffic mix (ruled out).
4. Show the decomposition: the drop is mostly *abandonment* and not rejections, which matches a slow provider.
5. Say: "Each score is the share of the drop that would disappear without that cause. They can overlap and this is correlation under a model, not proof; the page says so."
6. Optional contrast: open the 5 Oct RCA. The policy change shows a small score; the page explains this is the known baseline-overlap artefact. Being upfront about it is the point.

## 4. Simulator (2:45 to 3:30): "what"
1. **Workbench > Simulator.** Lower the FOIR hard cap from 0.50 to 0.45 and click **Run simulation**.
2. Show baseline, candidate and change cards: approvals fall and expected NPA falls by only a little. (For reference, one measured run during development, FOIR hard cap 0.50 to 0.45 and soft cap 0.40 to 0.38, lowered the approve rate by 2.1 points and expected NPA from 1.42% to 1.37%. Quote the numbers on your screen, not these.)
3. Say: "Conversion and credit risk sit side by side. The default risk is a synthetic ground truth and no behavioural reaction is modelled; the notice is on the page."
4. Try the opposite: lower the score cut-offs and watch approvals and NPA both rise.

## 5. Compliance (3:30 to 4:15): "is it allowed"
1. **Workbench > Compliance.** Ask: "What is the cooling-off period for a digital loan?" Show the quoted text with **Clause 10** citations.
2. Point at the permanent notice: the PDF is stamped **Withdrawn**, so verify what is currently in force; not legal advice.
3. Ask something out of scope ("who won the cricket world cup"): "Not found in the Directions".
4. Say: "Answers are extractive: the system quotes the paragraph and cites it. On my 20-question set the right clause is first for 85% and in the top three for 90%, but I tuned the ranker on that same set, so read it as a regression guard. DLG-style abbreviations are a known miss."

## 6. Experiments (4:15 to 4:45): "did it work"
1. **Workbench > Experiments.** Click **Create demo experiment**, **open** "Show the KFS summary above the Accept button", set the true acceptance effect to 2 points and click **Generate and analyse**.
2. Show: primary metric with a 95% interval, the **sample-ratio check**, guardrails (default rate, TAT, complaints) and the **SHIP** decision with the generated brief.
3. Set **Lose % of treatment users (logging bug)** to 10 and regenerate: the SRM check flags the mismatch and the decision becomes **HOLD**.
4. Say: "The cohort is simulated with a known effect, so it demonstrates the method, not a business result."

## 7. Mock controls (4:45 to 5:00, optional): "break it"
1. **Mock controls > bureau slowdown**, then start a few journeys (or `npm run live-load -- --n 100`). Watch the recorded p95 climb to the timeout and `BUREAU_UNAVAILABLE` referrals appear. Switch back to **normal**.
2. Say: "This is how the 13 Oct story was generated, and how the detector and RCA can be tried live."

## Likely questions during the demo
- *Is the data real?* No, generated; the generator also knows who would default, which a real lender never does.
- *Does the LLM decide anything?* No. It is off by default; when on it only rewords, and every number is checked.
- *Why not just use an LLM for RCA?* See `docs/INTERVIEW_QA.md`.

## Before you present: checklist
- Banner visible on every screen you share.
- Dataset in its seeded state (reseed if you ran live-load a lot).
- You have run each click path once; the Anomalies "Investigate" link was verified by route test, not by a long manual run.
- No language-model key is set unless you want to show the "wording by a model" note (then say it was only tested with a fake client).
