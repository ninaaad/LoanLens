# LoanLens metric tree

> **Synthetic data.** Values are measured from the generated dataset (26,879 applications, 10 Sep to 19 Oct 2026). They show how the metrics relate, not what a real lender would see.

## North star

**Disbursal conversion = loans disbursed / applications started.** Measured: 5,010 / 26,879 = **18.6%**.

It is the product of five step conversions. Each step is "reached this step / reached the step before":

| Step | Metric | Measured | What moves it | Where LoanLens looks |
|---|---|---|---|---|
| Start to KYC | KYC completion | 81.8% | KYC provider latency and errors, app release (document capture), applicant device | Funnel, RCA (`kyc API slowdown`, releases) |
| KYC to eligibility | Pre-screen pass | 86.2% | Age and income rules, applicant mix | Funnel, simulator (`income_min`), RCA (mix) |
| Eligibility to offer | Offer viewed | 48.8% | **Bureau latency and errors** (abandon while waiting, or referral on fallback), **credit rules** (score, FOIR), applicant mix | Funnel, RCA (bureau slowdown, policy change), simulator |
| Offer to accept | Offer acceptance | 58.1% | Price (rate band), amount cut vs request, KFS clarity, copy and layout | Experiments (acceptance), simulator (acceptance model) |
| Accept to disburse | Disbursal | 93.3% | Final checks, drop-off after acceptance | Funnel |

Eligibility to offer is the weakest step, so most of the RCA and simulator work targets it. Of everyone who starts: 8,244 are rejected and 5,370 are sent to manual review at some point.

```
Disbursal conversion (north star)
├── KYC completion ................ provider health, release quality, device mix
├── Pre-screen pass ............... age / income rules, applicant mix
├── Offer viewed .................. bureau health, credit policy (score, FOIR), mix
│     ├── abandoned while waiting . bureau p95 latency, timeouts
│     ├── rejected ................ SCORE_TOO_LOW, FOIR_TOO_HIGH, ...
│     └── referred ................ SCORE_BORDERLINE, FOIR_BORDERLINE, BUREAU_UNAVAILABLE
├── Offer acceptance .............. rate, amount, KFS presentation
└── Disbursal ..................... post-acceptance checks
```

The RCA decomposition on the workbench splits a drop at a step into *converted / abandoned / rejected / sent to manual review*, because a drop from rejections (a policy matter) needs a different response from a drop from abandonment (a performance matter).

## Guardrails

A conversion gain only counts if these do not get worse.

| Guardrail | Definition in LoanLens | Where it appears | Honest status |
|---|---|---|---|
| **NPA** | Expected default share of expected-disbursed amount: sum(default probability x amount x P(accept)) / sum(amount x P(accept)) | Simulator output next to approvals; experiment guardrail "default rate" (tolerance +1.00 pt) | The default probability is a hand-set synthetic formula, not calibrated, by design: the project stays on its synthetic dataset |
| **Turnaround time (TAT)** | Median time from application start to disbursal; for experiments, median TAT with a normal-approximation interval | Funnel summary; experiment guardrail (tolerance +10%) | Simulated durations; the interval is approximate |
| **Complaints** | Complaint rate per exposed unit | Experiment guardrail (tolerance +0.50 pt) | **A simulated proxy**, not real complaints |
| Compliance | A change must be supportable from the Directions | Compliance tab with citations | Retrieval aid, not legal advice; source stamped Withdrawn |

Experiment decision rule: sample-ratio mismatch means **hold**; any guardrail **breach** means **stop**; a significantly worse primary metric means **stop**; a non-significant primary means **hold**; otherwise **ship**. A guardrail whose interval straddles its tolerance ("uncertain") is listed as a watch item and does not block shipping.

## Diagnostic (input) metrics

These explain movements in the step metrics and are what the RCA joins to the funnel.

| Metric | Source table | Used for |
|---|---|---|
| Provider p95 latency per hour, failure rate | `api_calls` | API hypothesis (dose-response: applicants who waited longer than 1.2 x the baseline 95th percentile convert less) |
| Applications on a build, by platform | `applications` joined to `releases` | Release hypothesis (difference-in-differences against other platforms) |
| Approve / refer / reject under the previous ruleset | `rule_versions` replay | Policy hypothesis |
| Mix of device, channel, employment, new-to-credit | `applications` | Traffic-mix hypothesis |
| `BUREAU_UNAVAILABLE` referrals | `applications` / mock status | Provider fallback effect |

## Detector settings

Baseline: median of the previous 14 days of the step's conversion (at least 7 days needed). Spread: the larger of the baseline's scaled MAD and the binomial standard error for the day's volume. Flag when z is -3 or lower **and** the drop is at least 3 percentage points. Settings live in `DETECTOR` in `server/src/analytics/anomaly.js`.
