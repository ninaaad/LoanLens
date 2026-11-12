# LoanLens: The Idea, Explained (design-first guide)

Purpose: explain LoanLens as a **product idea and system design**, in words you can speak. It is written so that you can talk about it confidently without needing to explain the code.

---

## 0. How to frame it honestly (read first)

**The truthful position:** *you designed the product and the system; a prototype was built from your spec using an AI coding agent, on synthetic data; you are strongest on the product and design layer, less on the implementation details.*

Why this is the safest line:
- It is true, and it matches the repository if anyone looks.
- It showcases what an APM interview rewards: problem framing, users, metrics, trade-offs, risk thinking.
- It doesn't invite code-level questions you'd struggle with, because you've already placed yourself on the design side.

**Do not say:** "I couldn't implement it." (A prototype exists, so that's inaccurate and easy to contradict.) **Do not say:** "I built it all myself from scratch." **Do not claim:** real data, real users, real business impact, or any real bureau/KYC/LLM integration.

**Script if asked "Is it built?"**
"I designed it end to end: the problem, the users, the metric tree, the guardrails and the architecture. A working prototype exists on synthetic data, built from my spec with AI coding help, so I can show the idea working. I'm most confident explaining the product and design decisions; for code-level details I'd be honest about where I'd need to look."

**Script if asked "Why isn't it further along / real?"**
"I had a short window once the process started, so I prioritised the design and a synthetic-data prototype over real integrations. Real lender data is confidential, so a real version would need an anonymised funnel and a few past incidents to validate against."

**If they ask to see it:** show it. Don't hide it. The Funnel, Anomalies and RCA tabs tell the story in two minutes.

---

## 1. The idea in three lengths

### One line
"A workbench that tells a lending PM where the funnel broke, why, what to change, whether it's allowed, and how to test it."

### 30 seconds
"In digital lending, when conversion drops, a PM has to work out where, why, what to change, and whether it's compliant. Those answers sit in four different tools owned by four teams, so a one-day incident takes days to diagnose, and the fix is argued without evidence. LoanLens is a single workbench that connects the loop: detect the drop, rank the likely causes, simulate a rule change with conversion shown next to credit risk, check it against RBI rules with citations, and test it with guardrails."

### 2 minutes (spoken)
"Imagine you're the PM of a personal-loan app. Overnight the share of people who get an offer falls from about 50% to 40%. You need to know four things. Where is it dropping: which step, which segment? Why: did we ship a bad release, is the credit bureau slow, did risk tighten a rule, or did a different kind of customer arrive? What can we change without raising bad loans? And is that change allowed under RBI's digital lending rules?

Today each answer lives in a different place. Funnels are in a product analytics tool. API health is in monitoring. Rules are in a decisioning console. Regulations are in a PDF. Different teams own each, so the PM chases people and a one-day problem takes days.

LoanLens connects them in one loop. First, *detect*: flag a step whose conversion is unusually low compared with its recent baseline. Second, *diagnose*: for each suspected cause, estimate how much of the drop would disappear without it, and also say what was ruled out. Third, *decide*: replay past applicants through a candidate rule change and show approvals next to expected bad-loan rate, because a conversion gain that raises defaults isn't a gain. Fourth, *check*: answer compliance questions by quoting the RBI text with clause citations, and say 'not found' when the text doesn't support an answer. Fifth, *experiment*: run an A/B test with guardrails and a fixed ship/hold/stop rule.

Two principles run through it. Credit decisions are always made by a deterministic, explainable rules engine, never by an AI model. And every number is honest about its limits: it's built on synthetic data, so it demonstrates the approach, not business results."

---

## 2. The problem, as a story

**The funnel.** A digital lender's customer goes: apply, verify identity (KYC), eligibility check, see an offer, accept, receive money. Each step loses people. The PM owns the conversion of the whole funnel.

**The incident.** One day a step drops sharply. Possible causes look the same from the outside:
- **A release:** the app update broke something (say, document upload on Android).
- **A provider problem:** the credit bureau or KYC service is slow or failing, so people give up while waiting.
- **A policy change:** the risk team tightened a rule, so more people are rejected.
- **A mix shift:** a marketing campaign brought in a different kind of applicant.

**Why it's painful.** To find out which, the PM needs data from analytics, engineering, risk and compliance, held by different teams in different tools. So diagnosis is slow, and decisions get argued on opinion.

**Why lending is special.** In most consumer apps, more conversion is simply good. In lending, approving more people can raise defaults (bad loans, NPA), and every disclosure and process is regulated by RBI. So a lending PM must see conversion, risk and compliance together. That combination is the gap.

---

## 3. Users and what they need

| User | Job to be done |
|---|---|
| **Lending PM (primary)** | Get a fast, defensible answer to "what broke and what should we do" that I can take to risk and engineering |
| Risk analyst | See the credit-risk cost next to any conversion gain |
| Compliance officer | See which clause a statement rests on, and how sure the system is |
| Engineer / SRE | Know quickly whether a provider slowdown or a release is behind the drop |

---

## 4. The solution: the loop, stage by stage

### Stage 1: Detect (where?)
- **Idea:** compare each step's daily conversion with its own recent history, and flag unusual drops.
- **How it would work:** baseline = the median of the last 14 days; measure how far today is below it, in robust standard-deviation units (a z-score); flag only if it's both statistically unlikely (z at or below -3) and practically meaningful (at least 3 percentage points lower).
- **Why median and robust spread:** past incidents inside the window shouldn't distort the baseline.
- **Honest limit:** some flags will be chance. A flag is a prompt to investigate, not proof.

### Stage 2: Diagnose (why?)
- **Idea:** don't just list what changed that day. For each suspected cause, ask "how much of the drop would disappear if this hadn't happened?" Rank causes by that share, and show what was ruled out.
- **The four causes it tests:**
  1. **Provider slowness:** compare applicants who waited unusually long with those who didn't. If waiting hurts conversion, longer waits should mean lower conversion (a dose-response pattern).
  2. **A release:** compare the affected platform before and after, adjusted for what happened on other platforms (difference-in-differences), so a market-wide dip isn't blamed on a release.
  3. **A policy change:** replay today's applicants under the old rules and count who is blocked only because of the new ones.
  4. **A traffic-mix shift:** re-weight the baseline by today's mix of device, channel and so on.
- **A decoy to test honesty:** include a harmless release on the same morning as the real incident; a good method should rule it out.
- **Where the drop went:** also split the drop into abandoned, rejected, and sent to manual review. A drop from rejections is a risk-policy matter; a drop from abandonment is a performance matter. Different owners, different fixes.
- **Honest limit:** this is correlation under a modelled counterfactual, not proof of causation. The real confirmation is acting (a rollback, or an experiment) and watching what happens.

### Stage 3: Decide (what to change?)
- **Idea:** let the PM edit the rules (score cut-offs, income-to-obligation limits, loan size) and see the effect on past applicants before changing anything real.
- **How it would work:** replay stored applicants through the old and new ruleset; report approvals, referrals, rejections, expected disbursals, and expected bad-loan share (expected NPA) together.
- **Why both numbers always appear together:** a conversion gain that raises defaults isn't a gain.
- **Honest limits:** it assumes applicants don't change behaviour after a policy change; and a real lender never observes defaults for people they rejected, so real use needs a method called reject inference.

### Stage 4: Check (is it allowed?)
- **Idea:** answer compliance questions from the RBI Digital Lending Directions, with citations.
- **How it would work:** split the document by clause and paragraph; find the passages that best match the question; reply with the quoted text and its clause label; reply "not found" if nothing matches well enough.
- **Why quoting, not generating:** in compliance, a fluent wrong answer is worse than a quoted paragraph. Nothing can be invented, and a reviewer can verify the quote.
- **Honest limits:** keyword matching can miss synonyms; the version of the Directions I used is stamped "Withdrawn," so any answer needs the currently applicable instruction checked; it's not legal advice.

### Stage 5: Experiment (did it work?)
- **Idea:** once a change is chosen, test it with an A/B experiment that has built-in safety checks.
- **Pieces:** deterministic assignment (a given user always sees the same version); a significance test on the main metric (for example offer acceptance); a **sample-ratio check** (if the split isn't what you configured, the data is untrustworthy, so don't decide); **guardrail metrics** (default rate, turnaround time, complaints) with tolerances; and a fixed decision rule: ship only if the main metric improves significantly and no guardrail is breached; hold if unclear; stop on a breach.
- **Honest limits:** a single look at the data, only two variants, and no correction for repeated peeking.

### The supporting journey and rules engine
Around the loop sits a simple loan journey (apply, KYC, eligibility, offer with a Key Fact Statement, accept). Its decisions come from a **versioned rules engine** that returns approve, refer or reject with reason codes. Two design points to say out loud:
- **The rules decide; AI never does.** Decisions must be explainable, repeatable and auditable, and the borrower is owed reasons.
- **Failures degrade safely.** If the credit bureau times out, the application is sent to a human reviewer with a clear reason code. It isn't rejected for a provider's fault and isn't approved blindly.

---

## 5. Key concepts in plain words

- **FOIR:** share of monthly income already committed to loan payments, including the new one. A cap prevents over-borrowing.
- **EMI:** the fixed monthly payment.
- **NPA:** a loan that has gone bad. Expected NPA is the expected share of lent money that will default.
- **Credit bureau score:** an outside agency's summary of a person's credit history.
- **KYC:** identity verification before lending.
- **KFS (Key Fact Statement):** the standard sheet of loan terms a borrower must see before accepting.
- **Cooling-off period:** a window in which the borrower can exit without penalty.
- **Refer:** send to a human credit officer for a borderline case.
- **Reason codes:** machine-readable explanations for a decision.
- **Guardrail metric:** a metric that must not get worse while you improve the main one.
- **Sample-ratio mismatch:** the A/B split doesn't match the plan, so results can't be trusted.

---

## 6. Design decisions and trade-offs (your PM judgment)

| Decision | Alternative | Why this choice |
|---|---|---|
| Deterministic rules engine for credit decisions | ML or LLM decisions | Explainability, auditability, reproducibility, reasons for the borrower |
| Quote-based compliance answers | Generated answers | Nothing invented; checkable |
| Always show conversion next to risk | Show conversion alone | In lending the trade-off is the point |
| Ranked causes with ruled-out list | A single "root cause" | Honest about overlap and uncertainty; shows what was checked |
| Fixed decision rule with guardrails | Judgement per experiment | Prevents shipping on bad data or hidden harm |
| Synthetic data with planted incidents | Waiting for real data | Real lender data is confidential; planted answers let you check the method |
| Non-goals: no ML credit model, no real bureau/KYC integration, no auto-action, no multi-tenant | Bigger scope | Keep the project about the decision loop |

---

## 7. Success metrics

**North star:** disbursal conversion = loans disbursed / applications started.
**Step metrics:** KYC completion, eligibility pass, offer viewed, offer acceptance, disbursal.
**Guardrails:** expected NPA, turnaround time, complaints, and compliance traceability.

**What success would look like with real use (none of this is measured):**
- Time from "conversion dropped" to "ranked cause with evidence" under an hour.
- Fewer reversed decisions after experiments.
- Every compliance statement traceable to a clause.

---

## 8. Landscape and differentiation

| Category | Examples | What they do | What's missing |
|---|---|---|---|
| Product analytics | Mixpanel, Amplitude | Funnels, segments | No link to API latency, credit rules or risk |
| Observability | Datadog and similar | API latency and errors | No link to funnel conversion or policy changes |
| Loan origination / rules systems | Finflux, LendFoundry, Nucleus Software, TCS BaNCS, FinBox LOS | Run journeys and decisions | Built to run loans, not to explain a drop or show conversion beside risk |
| KYC / data providers | Perfios, Signzy, IDfy | Identity checks and data | They are inputs, not analysis |
| Document chatbots | General RAG tools | Answer from text | Don't know your funnel or rules |

(The vendor list is a starting point from a vendor-authored article; the "what's missing" column is my own assessment.)

**Differentiation:** not a better version of any one tool; the connection between them, with lending-specific logic (reason codes, FOIR, bureau and KYC dependencies, risk beside conversion, RBI citations).

---

## 9. Risks and what's unvalidated

1. **Spurious causes:** correlated events can look causal. Mitigation: counterfactual scoring, comparison groups, a decoy test, and explicit caveats.
2. **Detector noise:** some flags will be chance. Mitigation: dual threshold; treat flags as triage.
3. **Stale or wrong compliance answers:** the source is a withdrawn version. Mitigation: quotes only, "not found" below a threshold, a standing warning.
4. **Over-trusting simulations:** defaults are only observed for approved loans. Mitigation: show the caveat; use reject inference in real use.
5. **Fairness and privacy:** rules use attributes like age and employment type. A real version needs a fairness review and consent and data-minimisation controls.
6. **Adoption:** a PM tool only works if risk and compliance trust its numbers. Mitigation: evidence on screen, caveats visible, no auto-action.

**Unvalidated:** it has never seen real lender data. The prototype only demonstrates that the method separates causes I planted myself.

---

## 10. What next (if they ask "how would you take this forward?")
1. Interview 5-8 lending PMs, analysts and risk people about the last conversion drop: how long diagnosis took, which tools, who was involved.
2. Get an anonymised funnel and 2-3 past incidents with known postmortems; check whether the ranked causes match what the team concluded.
3. Fit default behaviour on real repayment data, with reject inference.
4. Add sequential testing, and a change-approval workflow and audit trail for rules.
5. Refresh the regulatory corpus from the currently applicable instruction, with an owner.

---

## 11. Resume points (design-led)

Tip: keep the bullets accurate to what you did (design, spec, prototype) and drop any technology you didn't use. LoanLens does **not** use Redis or pgvector, so don't list them on this project.

**Option A (recommended: design-led, honest)**

> **LoanLens: PM Workbench for Digital-Lending Funnels (product design + synthetic-data prototype)** | *PostgreSQL, Node.js, React* | Oct 2026
> - Defined the problem, users and PRD for a lending PM workbench that connects funnel drop detection, root-cause ranking, rule what-if simulation, RBI compliance lookup and A/B testing in one decision loop; set the north-star metric (disbursal conversion) and guardrails (NPA, turnaround time, complaints).
> - Designed a deterministic, versioned rules engine (approve/refer/reject with reason codes), a what-if model that shows conversion next to expected NPA, and an RCA approach that ranks causes by counterfactual share of the drop, tested against planted incidents including a decoy release.
> - Specified a citation-first compliance assistant over the RBI Digital Lending Directions and an experiment framework with sample-ratio checks and guardrail-based ship/hold/stop rules; validated the approach with a synthetic-data prototype (AI-assisted build).

**Option B (shorter, 2 bullets)**

> - Authored the PRD, metric tree and design for a lending-funnel PM workbench (detect, diagnose, simulate, check compliance, experiment), with deterministic credit rules and conversion-versus-risk trade-offs.
> - Prototyped the design on synthetic data with AI-assisted development: root-cause ranking validated on planted incidents, citation-based RBI Q&A, and guardrailed A/B decision rules.

**LaTeX version of Option A (for your Overleaf template)**
```latex
\resumeProjectHeading
  {\textbf{LoanLens: PM Workbench for Digital-Lending Funnels} $|$ \emph{PostgreSQL, Node.js, React}}{Oct 2026}
  \resumeItemListStart
    \resumeItem{Defined the problem, users and PRD for a lending PM workbench connecting funnel-drop detection, root-cause ranking, rule what-if simulation, RBI compliance lookup and A/B testing in one decision loop; set the north-star metric (disbursal conversion) and guardrails (NPA, turnaround time, complaints).}
    \resumeItem{Designed a deterministic, versioned rules engine (approve/refer/reject with reason codes), a what-if model showing conversion next to expected NPA, and an RCA approach ranking causes by counterfactual share of the drop, tested against planted incidents including a decoy release.}
    \resumeItem{Specified a citation-first compliance assistant over the RBI Digital Lending Directions and an experiment framework with sample-ratio checks and guardrail-based ship/hold/stop rules; validated the approach with a synthetic-data prototype (AI-assisted build).}
  \resumeItemListEnd
```

Also on your resume: remove **pgvector** and **Redis** from LoanLens-related skills claims if you can (Redis belongs to TaskForge; LoanLens retrieval uses Postgres full-text search, not vectors).

---

## 12. Likely questions (spoken answers)

**Why did you build this / what problem?** "In lending, a conversion drop can come from a release, a slow provider, a policy change or a mix shift, and the evidence lives in different tools owned by different teams. I wanted one workbench that connects detection, diagnosis, simulation, compliance and testing."

**What would be your MVP?** "Detect plus diagnose plus simulate on one funnel, because that's where PM time is lost. Compliance lookup and experiments come second, since they depend on trust in the first three."

**How would you prioritise features?** "By the PM's decision loop and by cost of being wrong. Diagnosis and the conversion-versus-risk view come first. I would not build ML scoring or auto-actions early, because they raise risk and reduce trust."

**How would you know it works?** "On real data I'd check whether its top-ranked cause matches what the team concluded in past postmortems, and I'd measure time to diagnosis before and after. Success is faster diagnosis, fewer reversed decisions and traceable compliance statements."

**What's the biggest risk?** "People over-trusting a ranked cause or a simulation. That's why every screen shows caveats, why scores are framed as correlation under a model, and why nothing acts automatically."

**Why not use an LLM for the decisions or the RCA?** "Credit decisions must be explainable and reproducible. An LLM could invent facts or drift. If used at all, it should only reword text from verified evidence."

**Build vs buy?** "Buy the commodity pieces: product analytics, monitoring, the decisioning engine. The value I'm proposing is the connecting layer and the lending-specific logic, which is unlikely to come off the shelf."

**What would you ask a lender before building?** "How long diagnosing the last conversion drop took and who was involved; which tools they used; how rule changes are approved; where default labels come from for rejected applicants; and which regulations apply to each change."

**How do fairness and privacy fit?** "Rules use attributes such as age and employment type, so a real version needs a fairness review and consent and data-minimisation controls. I haven't done that; it's a prerequisite for real use."

**Is it real?** "No. It's a design validated by a synthetic-data prototype, so it shows the approach, not business results."

---

## 13. Last-minute checklist
- Say the 30-second version out loud once.
- Remember the five stages: detect, diagnose, decide, check, experiment.
- Remember the two principles: rules decide, not AI; every number is honest about its limits.
- Volunteer the three limits: synthetic data, correlation not causation, withdrawn compliance source.
- For every "why" answer in this shape: **need, choice, trade-off, what I'd do with more time.**
