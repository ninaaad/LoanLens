# Responsive UI and eight evaluation loops

> **Synthetic data.** All data stays synthetic and the generator and the shipped dataset were not touched. Every figure here is a measurement on generated data.

This round had one main task (make the UI responsive) and then eight loops. Each loop evaluated the whole product (journey, rules, analytics, simulator, compliance Q&A, the optional language model, experiments, mock controls, the HTTP layer and every UI page), listed what was wrong and what could be better, fixed what could be fixed, and the next loop re-ran the same evaluation. The evaluation is repeatable:

| Command | What it does | Time |
|---|---|---|
| `node scripts/evaluate.mjs` (optionally with area names such as `http rag llm`) | 170 checks and 15 notes across the whole product, on a throwaway database. **FAIL** = bug, **NOTE** = measurement | about 2 minutes |
| `node scripts/evaluate-detector.mjs default 1 2 3` | re-rolls the synthetic world with other seeds and measures the detector and the RCA | about 25 s per draw |
| `node scripts/evaluate-experiments.mjs 150` | repeats the experiment decision rule 150 times per true effect | about 1 minute |
| `npm run check` | the test suite and the production build | about 3 minutes |

The harness first ran with 2 failures (loop 1) and ended with 170 passing checks and none failing (loop 8). Tests went from 112 to 131 (server 109, web 22).

## The main task: a responsive UI

**What was wrong** (measured at 320, 375, 768, 1024, 1280 and 1440 px on all nine routes): the Experiments tables ran 760 px wide on a 375 px phone; the top bar and the tab row wrapped onto two or three lines and pushed content down; number fields had fixed pixel widths; one breakpoint (860 px) meant four-up stat grids were squeezed on tablets and then jumped to one column; charts had fixed heights; no touch-target sizing; inputs under 16 px make iOS zoom the page; light-theme chart legends were hard to read.

**What changed** (`web/src/styles.css`, `App.jsx`, small edits in the pages):
- Grids size themselves (`auto-fit` with a minimum width and a column cap), so there are no breakpoints to get wrong; the journey form has its own field grid.
- The top bar stays on one line (the theme button becomes an icon on phones, the brand text hides at 640 px); the workbench tabs are one horizontally scrolling row that is sticky, and the current tab scrolls into view.
- Every table is inside a scroll container; form fields flex and fill the width on phones; fluid page gutters and card padding; safe-area insets for notched phones.
- 16 px inputs on phones, 42 px touch targets on touch devices, bigger link targets on small screens, reduced-motion support, long words wrap.
- Charts: responsive heights, and legend text no longer takes the pale series colour.
- A skip link, one (hidden) `h1` and a real tab title per page, and `aria-live` on the compliance answer.

**Result:** no horizontal overflow and no text under 4.5:1 contrast on any of the 8 pages in light and dark at 320 px; the same at 375, 768, 1100, 1280 and 1440 px (checked by script in the browser pane, plus screenshots of several pages). Not verified: a real phone, other browsers, and screen readers.

## Loop 1: functional sweep (journey, rules, analytics, simulator, compliance, model, experiments, mock controls)

**Bugs found and fixed**
1. **RCA claimed "likely, 100%" causes on quiet days.** On 12 Oct the conversion moved 0.1 points, yet the policy change and traffic mix both scored 100%, because a score is a share of the drop and the drop was nearly zero. It now first asks whether the day's change is worth explaining (at least 3 lost conversions and z of at least 2); if not, nothing is scored and the narrative says it is within normal variation. The UI shows a notice.
2. **Parallel requests duplicated work.** Three simultaneous "get offer" requests wrote three `offer_viewed` events and called the bureau three times (a double click or a retrying client does this). Steps for one application now run one at a time.
3. **Experiment inputs were unbounded.** A true effect of 5 (500 points) was accepted. Effects must be believable probability points (±0.5; time change −90% to +500%).
4. **The language-model number check ignored signs and length.** "-6.9" and "6.9" were equal, and a 10 kB answer was accepted. Signs are now checked (a number may lose its minus sign but never gain one), and output is capped at 1,500 characters.
5. **A question made only of list markers ("a:* & b | !c") got an answer** from the Directions' (a), (b), (c) markers. Single letters are no longer query terms.

**Improvements:** the simulator now reports a backtest (expected disbursals under the baseline against the loans that actually disbursed); durations read as "6.0 min", not "0.1 h".

## Loop 2: the HTTP layer
**Bugs fixed:** no security headers (now `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`); a missing script such as `/assets/nope.js` returned the HTML page with status 200 (now a real 404); **the application resource exposed the synthetic ground truth** (latent bureau score, default probability, `would_default`), which a real borrower never sees (now hidden); every analytics request recomputed for 0.8 s and 12 parallel funnel requests took 6.3 s (results are cached per database, valid until the data changes, and identical simultaneous requests share one query: a repeat now takes about 0.1 s and 12 parallel take 1.3 s).
**Checked and fine:** malformed and nested JSON, wrong content types, preflight, HEAD, trailing slash, 400+ fuzzed requests (none a 5xx).

## Loop 3: UI accessibility and messages
**Fixed:** no page title or `h1` on any page; no skip link; when the API was down the UI said "Request failed (500)" (what you saw when `npm run dev` failed): it now says the API is not responding and how to start it; the journey form had no min/max/step; the brief's markdown heading made a second page-level heading.
**Checked:** every control is labelled, no unnamed buttons or links, contrast, and the error text for invalid journey input.

## Loop 4: the models (detector, RCA, simulator), re-rolled across seeds
The shipped dataset is one draw, which says little about error rates, so `evaluate-detector.mjs` generates other draws (never touching your data). **Findings:** the daily detector found the Android regression and the bureau slowdown in every draw, but found the FOIR policy change in only 2 of 8 draws, because a lasting few-point shift is hidden by day-to-day noise; the RCA once ranked a hotfix release above the real bureau cause because a shared shock hit one platform harder by chance; the simulator's backtest showed it under-predicts disbursals by 17%, which the data explains: 699 of the 5,011 disbursed loans were first referred to manual review, which the simulator does not count; and `npm run seed` style imports crashed under `node -e` (a missing `argv[1]`).
**Fixed:** a second **sustained-shift detector** (4-day pooled window against the 14 days before, z of −3 or lower and at least 2 points; episodes merged; reported separately and never changes the daily flags). Over 8 draws it found the policy change in 7 and raised 0 unexplained episodes (window and threshold were chosen on these same 8 draws, so treat that as optimistic). Release scores are halved when the release's own notes name a different funnel step. The backtest now shows how many disbursals followed a manual review. Scripts no longer crash without `argv[1]`.

## Loop 5: compliance Q&A and the language model
**A held-out question set** (`server/test/rag_heldout.json`, 20 in-scope and 6 out-of-scope questions, written after the design was fixed and not used for tuning) gives a fairer number: BM25 clause hit@1 **85%**, hit@3 **90%**, against 25% and 60% for the first ranker; but only **4 of 6** out-of-scope questions were refused ("maximum tenure of a home loan" and "capital of France" got answers because the Directions contain "tenure" and "capital"). The in-scope figures matched the tuned set, which supports them; the refusal weakness is real. I tried the obvious fix (require two matched terms) and it cost an in-scope answer for one refusal gained, so I did not ship it.
**Language model:** a digit-free invented claim that cites a real clause ("every loan is approved, as Clause 10 confirms") passed the number check. A **groundedness check** now requires at least 60% of an answer's content words to occur in the evidence; it applies to the compliance rewrite, the RCA narrative and the brief summary.

## Loop 6: experiments, and contrast
`evaluate-experiments.mjs` (150 repeats, 40,000 users): the 95% interval contained the true effect 93 to 95% of the time; with no effect the rule shipped 1.3%, held 94.7% and stopped 4.0%; a +1 point effect shipped 48%, +2 points 97%, +3 points 99%; a +2 points win with +3 points default rate stopped 99%; a 10% logging loss was caught by the sample-ratio check every time. **Added:** the **minimum detectable effect** (about 1.4 points at this size) in the analysis, the "hold" reason, the brief and the page, because a hold on a test that could not have seen the effect is not evidence of no effect. **Fixed:** light-theme contrast of chart legends and the green chips.

## Loop 7: cold start, performance, load
A first start in an empty data folder (`node server/src/index.js`) migrated, seeded 26,879 applications, indexed 99 chunks, served the built app and a missing asset returned 404. `live-load` with a bureau incident behaved (timeouts and `BUREAU_UNAVAILABLE` referrals rose, then recovered). **Fixed:** the first screen shipped a 608 kB script; workbench pages now load on demand (first-load script 161 kB, 53 kB gzipped); charts drew a line straight across a 16-day gap after live journeys (now a gap).

## Loop 8: regression
All 170 checks of the harness passed, the multi-seed run was repeated with the final code (8 draws: the RCA ranked the true cause first on all 32 Android and bureau incident days, up from 31 of 32 before the release prior; the daily detector raised 0 flags outside the policy window and found the policy change itself in 2 of 8), the responsive and contrast sweep was repeated at 320 px in both themes on every page, and `npm run check` passed (131 tests).

## Not fixed (measured, and open)
- **Compliance refusal** is the weak spot (4 of 6 on unseen out-of-scope questions); lexical search cannot tell an unrelated question that shares a word.
- **The daily detector** still misses a few-point lasting shift on its own; the shift detector covers it with the caveats above, and its settings were chosen on 8 draws.
- **RCA scores can still overlap by chance** when one platform is hit harder by a shared shock; the halving prior reduces but does not remove it. Within about a week after a policy change the baseline overlaps the old regime, and the 5 Oct flag sits in that window, so it may be partly the same effect (across 8 draws there were **no** unexplained daily flags outside that window).
- **The simulator under-predicts** disbursals by about 17% on the full data (referrals are not counted); the backtest shows it rather than hiding it.
- **The per-application lock is in one process only**; several API processes would need a database lock. The Windows process-cleanup code is Windows-only.
- Open CORS, no authentication (so `POST /api/admin/reseed` and `POST /api/rules` are open), dev-tooling `npm audit` findings, no real-device or screen-reader testing, no end-to-end browser test.
