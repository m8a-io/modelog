# Modelog Enterprise

**Status:** Proposal for review; no implementation commitment. Specifies Part 3 of the PRD (§7.11–§7.13, §9) and builds directly on `PROCESS-INSIGHT.md`.

**Research date:** 2026-10-10.

Modelog Enterprise aggregates the routines Process Insight discovers on each developer's machine, finds where they **converge across an organization**, and turns the convergence into ranked, costed business cases for automating or standardizing the process itself. It then distributes the fix and measures whether it took.

The thesis in one line: **the convenience of AI makes organizations stop automating, and Modelog is the counterweight.** Paying a frontier model to improvise the same process hundreds of times a month is both the cost leak and the quality leak — every execution is a fresh improvisation, so no standard exists and none can be exceeded.

## 1. What aggregation makes visible

Individual Process Insight finds one developer's routines. Aggregation makes three things true that are false for any individual:

1. **Savings multiply by headcount.** A routine worth $14/month to one developer never justifies shared infrastructure. The same routine across 40 developers is a run-rate that pays for a platform team building the automation once. Platform teams today guess what internal tooling to build; the rollup gives them measured demand, ranked in money.
2. **Variance becomes measurable.** The same nominal process — "release", "triage", "PR review" — appearing as many distinct routine shapes, on many models, with a wide cost-per-occurrence spread, is simultaneously a cost finding and a quality finding: no canonical process exists. Classic process mining checks conformance against a reference process; here the sharper result is usually that **there is no reference process, and the absence is the finding**. Variance is computed entirely from derived data — sequence shapes, cost distributions, model mix — with no one reading anyone's prompts.
3. **Fixes change ownership.** What the individual could only adopt personally, the organization can build once (CI), publish once (a canonical skill or sub-agent definition), or deliberately leave free. The org-level decision per converged process is a three-bucket sort, with evidence:

| Bucket | Mechanism | What it buys |
| :--- | :--- | :--- |
| **Automate** | CI / deterministic tooling (hierarchy tier 1–2) | Tokens go to zero; the step is enforced, not requested |
| **Standardize** | One vetted skill / sub-agent definition, fleet-distributed (tier 3) | Variance collapses; the same steps run the same way every time, on the deliberately chosen model |
| **Leave free** | No intervention (tier 5 territory) | Improvisation where improvisation is the point |

## 2. Standards are the quality story

Standardize (tier 3 of the hierarchy, added to `PROCESS-INSIGHT.md` §2 on 2026-10-10) is where cost saving and quality converge, and it is the part of the offering that goes beyond money:

- Standards can only be set when everyone does the same things the same way every time. A fleet-distributed canonical skill is exactly that, for work an LLM still executes — the steps the org actually wants (changelog, version bump, attribution, review gates), on the deliberately chosen model, identically on every machine.
- Quality then improves through the same loop the product already has: the fleet-wide before/after measurement **is the unfiltered feedback channel on the process itself**. A standard that doesn't move the numbers, or that developers route around (§6 drift), is visible — so standards get revised on evidence, not opinion.
- The pitch to leadership is therefore not "spend less on tokens." It is: **find where your people are paying AI to improvise, and decide on evidence which of it becomes process.** Excellence as a side effect of cost discipline.

## 3. The artifact that travels up the chain: the automation backlog

Not dashboards — business cases. Each backlog entry is one converged process:

- The routine shape, how many developers and teams exhibit it, occurrence trend.
- Org-wide run-rate per source, in that source's unit (never blended — §8), at enterprise rates where supplied (§7).
- Variance: shape count, cost-per-occurrence spread, model mix.
- Suggested bucket (automate / standardize / leave free) with the payback framing: run-rate against estimated build effort.
- Lifecycle state: `candidate → accepted → shipped → measured → watching` (drift, §6). Each transition is an org-level marker, so before/after windows are anchored exactly as personal markers anchor them.

**The suggestion layer recurses.** The rollup gets its own read-only MCP server — the Job B pattern (PRD §7.6) one level up. The platform team's or leadership's own agent reasons over aggregated routines and drafts the proposals and the quarterly process-health narrative; Modelog does all arithmetic, the agent does all judgment, the methodology ships as an explicitly invoked prompt. Same rules as `PROCESS-INSIGHT.md` §4–5, same declarative-data-only discipline.

> **Component boundary, stated to prevent a false alarm:** PRD invariant 6 ("the MCP server has no write tools") and MCP.md's "not a network service" describe the **local** bridge, and remain true of it. The enterprise rollup MCP endpoint is a different component with its own rules: remote, authenticated, tenant-scoped — and still read-only. Backlog state changes happen through the enterprise UI, not through MCP.

## 3a. Worked example — the CI-triage tax

*Added 2026-10-10 on review. The figures are illustrative; the mechanics are the specified pipeline end to end. The point of the example: a finding that is invisible to every individual and only exists at the aggregate vantage point.*

**What each developer experiences — and ignores.** A 40-developer org has a test suite with a slowly growing flake problem. A developer pushes, CI fails, they hand the failure to their AI assistant. The agent pulls the log, pokes at the test, reruns, concludes "flaky, not yours," and the developer merges. Six turns, four minutes, perhaps €0.30 at frontier rates. It happens about twice a week per developer — roughly €2.50 and ten minutes a month each. Nobody files a ticket. **Before AI assistants, this pain surfaced as grumbling in retros; now the AI absorbs it quietly, so the human feedback channel that used to carry the signal is dead.** The convenience hid the process failure. The logs still carry it.

**What the local pipeline records.** On each machine, Process Insight labels the segment — call it `[triage]`, sometimes `[triage, retry]` — from metadata and, where enabled, the local SLM (provenance and confidence recorded). The telling shape, all derived data: the segment starts shortly after a push, is Bash-heavy in tool mix, is short, and **ends with no file edits**. The developer's own dashboard may even show the routine — ranked around eighth among their personal routines at €2.50/month. No rational individual acts on their own eighth-place routine. That is the point: the waste sits below every personal threshold simultaneously.

**What the rollup sees.** 34 of 40 developers exhibit the same routine shape — the k = 5 gate is passed many times over, and no name is attached to anything:

- ~270 occurrences a month, trending +15% as the suite grows.
- Run-rate ~€85/month at the org's enterprise rates — and, from the duration statistics, **~20 developer-hours a month**, which dwarfs the token cost and is the number leadership actually hears.
- Variance: median cost per occurrence €0.25, but a p90 of €1.80 — some triages spiral into long investigations of the same already-known flakes.
- A quality flag no individual view could produce: in ~9% of occurrences the routine ends with an **edit to a `*.test.*` path**. File paths are metadata, so this is derivable without reading anything — developers are modifying tests *during triage*. Whether that is fixing or quietly skipping them is exactly the kind of question a human should now ask, and until this number existed, no one knew to ask it.

**The backlog entry and the suggestion.** The routine enters the automation backlog ranked near the top on run-rate × trend. The platform lead invokes the org MCP suggestion prompt; their own agent — which can also read the CI configuration in the infra repo, context Modelog neither has nor wants — proposes against the hierarchy, top-down: **tier 1**, an automatic retry-once plus a flake-quarantine workflow in CI, eliminating the human-plus-AI loop for the common case entirely; **tier 3**, a standard `ci-triage` skill on the org's cheap model for what remains — same steps every time (fetch log, classify, link the quarantine dashboard), and *never edit a test*; **leave free**: genuinely novel failures. Payback framing: about two days of platform work against twenty rising hours a month.

**The measurement.** The backlog item gets its `shipped` marker when the quarantine workflow lands. Eight weeks later: occurrences down ~80%; the remainder run through the standard skill on the cheap model; the test-edit-during-triage rate is near zero; the p90 collapsed. Those numbers attach to the backlog item — the platform team's ROI receipt. The item then sits in `watching`: if occurrences creep back next year, the quarantine list has stopped being maintained, and the backlog says so before any human notices.

**Why no individual could have found this.** Four separate reasons, each sufficient alone: the per-developer cost was under every personal radar; each developer saw only their own two occurrences a week, never the 270; the variance spread and the test-edit flag *only exist across people*; and the AI's convenience had silenced the social feedback channel that used to carry the complaint. The aggregation is not surveillance of forty people — no name appears anywhere in the finding. It is the only vantage point from which the process is visible at all.

## 4. Product surfaces

| Surface | Runs | Does |
| :--- | :--- | :--- |
| Sync agent | In the extension | Pushes derived routines, labels, and costs — never content — under §5's rules. The payload is inspectable before and after: every developer can see exactly what leaves their machine, field by field. |
| Rollup service | Modelog SaaS (§6a — hosting) | Cross-developer routine matching (possible because the label vocabulary is pinned — PRD §7.8's comparability argument, now commercially load-bearing), k-anonymity gating, variance analytics, trends. |
| Automation backlog | Enterprise web UI | §3. The chain-of-command artifact. |
| Fleet distribution | Extension + rollup | **The delivery mechanism for an accepted standard.** When the org adopts a canonical skill or sub-agent definition (§1's "standardize" bucket), this is how that file reaches every seat — offered through the extension rather than through a wiki page and an email. The per-machine consent model from `PROCESS-INSIGHT.md` §6 is **unchanged**: preview of exact files, explicit accept, clean removal; never silently installed. Adoption is then measured, not assumed. Not in v1 (§10.5). |
| Org MCP server | Modelog SaaS | §3's recursion. Read-only, authenticated, tenant-scoped. |

## 5. Invariant: Modelog ranks processes, not people

Proposed as **PRD invariant 8**, with the same standing as "never reads content" — a promise the product makes, enforced structurally where possible. The proposed wording for the PRD §8.0 list:

> **8. Org-level data aggregates by routine, never by person.** No per-person ranking view, query, or export exists; no routine is org-visible below k = 5 distinct developers; Modelog never holds the pseudonym-to-person mapping.

Like invariants 1 and 5, it is adopted only with its enforcement: the k-gate asserted in the query layer by tests, and the ranking view absent by construction rather than hidden by configuration. The expansion:

1. **The rollup aggregates by routine, never by person.** A routine enters any org-visible view only when **≥ k developers** exhibit it (k configurable per org with a floor Modelog enforces; below the floor the data participates in nothing). Enforced in the query layer the way `compare_models` enforces vendor grouping — by shape, not by policy.
2. **No per-person spend or usage ranking exists as a view, a query, or an export.** Not de-emphasized — absent. Competitors will ship the leaderboard; refusing it is the differentiation, and it is what makes the tool adoptable by the people whose machines it runs on.
3. **Pseudonymous at the vendor.** The client generates a random stable developer ID; the mapping to a human lives with the customer organization, never with Modelog. Concretely: Modelog's database holds `dev_8f3a…` next to routine counts, while the table saying who `dev_8f3a…` is exists only on the customer's side — so a breach, an insider, or a legal demand against Modelog yields behavioral rows that name no one. Modelog-the-company cannot re-identify a developer in its own database. (Pseudonymized behavioral data is still personal data under GDPR — this measure reduces exposure; it does not exempt anything, and §6's compliance posture still applies in full.)
4. **Sync is explicit and inspectable** (PRD §7.11 unchanged): derived data only, developer-visible payload, opt-in per machine. An org can mandate participation contractually; Modelog's software still shows the developer exactly what is sent.

The business rationale is the user-stated principle this encodes: leadership should always look at process before people. A tool that made the opposite easy would poison its own install base — the extension is local-first and developers are the deployment path.

## 6. Closing the loop at fleet scale — and the reason it stays bought

- **Before/after per backlog item:** after a fix ships, the routine's occurrences fall (or don't) across the fleet; adoption rate per team; cost delta per source. This is the platform team's ROI evidence — a thing platform/DevEx teams famously lack — which makes them the internal champion, with engineering leadership as the economic buyer.
- **Drift detection is the recurring value:** a routine reappearing months after its automation shipped means the process regressed — new hires don't know the path, or the tooling broke and people routed around it through the AI again. A one-time audit finds the first win; only continuous measurement catches decay. That is the subscription justification.
- All comparisons remain observational, inheriting every honest-numbers caveat (PRD §8.2): work mix, model versions, and rates all move between windows; Modelog shows what changed, not proof of cause.

## 6a. Hosting: SaaS-first, portable by construction

**The lead offering is multi-tenant SaaS, EU-hosted.** An earlier draft of this thinking leaned self-hosted-first; that lean is demoted to a later deployment option, for these reasons:

- **The hard privacy work is done by data minimization, not hosting location.** What reaches the rollup is derived, content-free, pseudonymous, and k-gated before visibility. "We never receive the dangerous data" is a stronger safety claim than "we host the dangerous data carefully" — and it is a claim a self-hosted deployment cannot improve on, because there is nothing sensitive to repatriate.
- **Support economics.** Self-hosted means N bespoke environments, version skew, and debugging in the dark — a poor fit for a small vendor. One SaaS deployment means fast iteration and a product that actually improves.
- **The vendor's jurisdiction is itself a trust asset.** A German GmbH operating EU-resident infrastructure, processing under GDPR as a processor for the customer-controller, is a procurement story most US dev-tool SaaS cannot tell.

**The safety stack the SaaS commits to:**

| Measure | Substance |
| :--- | :--- |
| Structural minimization | No prompts, no code, no content can arrive — the sync boundary (PRD §7.11) excludes them at the client; the server has no field to store them in. |
| Pseudonymization at source | §5.3 — Modelog never holds the identity mapping. |
| k-anonymity before visibility | §5.1 — enforced in the query layer, not the UI. |
| EU data residency | EU-region hosting; data processing agreement; customer is controller, Modelog is processor. |
| Tenant isolation | Per-org isolation at the data layer; org offboarding deletes the tenant. |
| Retention limits | Rollup data expires on a configured window; the system's value is trends and open backlog items, not a permanent archive. |
| Works-council pack | A standing document for employee representatives: every field collected, every view that exists, and — as important — the views that structurally do not (§5.2). German co-determination law gives works councils a say over systems capable of performance monitoring; arriving with this pack, and with §5 true by construction, is a sales accelerator rather than a hurdle. **Standard in every Enterprise contract and led with in sales — not an add-on (settled 2026-10-10).** |

**Portable by construction.** The rollup is built as one stateless service plus one database, configuration-driven tenancy, no hard dependency on any proprietary cloud service. This discipline costs little now and keeps two doors open for large accounts later: **single-tenant SaaS** (dedicated instance, same operator) and **self-hosted** (same artifact, customer-operated, support-tier priced). Neither is a launch commitment; both must remain cheap to add, which is a constraint on the first implementation, not a feature of it.

## 7. Enterprise rate tables

Organizations do not pay list price: enterprise agreements, committed-use discounts, and cloud-marketplace pricing (Bedrock, Vertex) all diverge from the public rate card `[varies by contract — confirmed as a class, individual terms obviously private]`. Part 1's shadow prices are honest for an individual; for an org they systematically misstate real spend.

- An org can supply **its own rate table per source** — versioned, dated, same schema discipline as `data/pricing.json` (PRD §8.2: integer rates in explicit units, modifiers as integer ratios).
- Applied at the rollup for all org-level figures, and optionally distributed to member clients so individual dashboards show org-true prices.
- Every figure states which table priced it. Unknown models still cost `null` — a negotiated table does not earn a default rate (invariant 3 unchanged).
- This *strengthens* the honest-numbers posture: estimates move closer to bills and are labeled with their provenance, rather than a blended guess.

**Settled 2026-10-10: a standard Enterprise feature, not a gated add-on.** An enterprise stating its own rates is table stakes for a tool whose pitch is real numbers.

## 8. What does not change at enterprise scale

- **No cross-vendor cost comparison** (invariant 5). A mixed Copilot + Claude Code org gets per-source totals side by side, never one blended "AI spend" number. The pressure to blend will be enormous; the answer is §7 — make each source's number real — not a conversion rate that is an inference, not a measurement.
- **The content boundary** (invariant 1, per-component). The enterprise backend joins the "never reads content" side of the boundary, in its strict form: unlike the opt-in local SLM, the backend has no relaxed scope at all.
- **Local-first for the individual.** The free personal product keeps working with zero network calls; Enterprise adds a sync on top of it, never a dependency underneath it.

## 9. Commercial outline

- **Economic buyer:** engineering leadership (cost control, standards). **Champion:** platform/DevEx teams (measured demand for their roadmap, proven ROI for their existence). **Deployment path:** developers, who accept the extension because §5 is true.
- **Seat arithmetic:** the product pays for itself if it surfaces one automation per quarter whose run-rate exceeds the seat bill — a low bar given what a single improvised publish flow costs at frontier rates.
- **Tiering (refines PRD §9):** Personal — free, local-only, includes Process Insight. Enterprise — per seat: rollup, backlog, fleet distribution, org MCP, enterprise rate tables, works-council pack — the last two standard at this price, not add-ons. A mid "Team" tier (small-k rollup, no fleet distribution) is plausible but undecided.
- **Pricing (settled 2026-10-10, decided prior to this document and recorded here):** **€12 per seat per month billed annually (€144/seat/year), or €16 per seat billed monthly.** Deliberately low: the seat bill must be an easy yes next to any single surfaced automation, and low enough that rollout friction, not budget, is the only adoption question.
- **Path:** one or two design-partner orgs before any self-serve motion, consistent with PRD §10's qualitative-first stance. The §7.13 chicken-and-egg mostly dissolves here: unlike the global benchmark, the org rollup needs only one team of ~5 to produce value.

## 10. Decisions — status after review 2026-10-10

1. **k floor — settled: k = 5.** Written into the proposed invariant wording (§5).
2. **Sync cadence — deferred** until the sync mechanism itself exists; sequenced behind decision 6.
3. **Invariant 8 adoption — open.** The proposed wording is now boxed in §5. Adopting it means adding rule 8 to PRD §8.0 together with its enforcement: a test asserting the k-gate in the query layer, and the per-person ranking view absent by construction. Remaining question: adopt now, or after a design partner validates the k mechanics in practice.
4. **Backlog tracker integration — deferred** until the backlog itself has proven out. (If it comes, pushing candidates into Jira/Linear would be Modelog's first outbound write anywhere, with everything that implies.)
5. **Fleet distribution — settled by sequencing: not in v1.** Rollup + backlog ship first; distribution (plain definition now in the §4 table) is a later release's headline. Until then, adopted standards are distributed by the org's own means and Modelog still measures adoption from the logs.
6. **Local → SaaS connection — reframed as the first technical task.** Before any org-MCP transport question: how a client enrolls in an org, how the sync agent authenticates, the payload schema, and how the developer-visible payload inspector presents it. The org MCP server's transport and auth follow from whatever this establishes. MCP.md's no-network promise gets a one-line component-boundary note when that work starts, not before.
7. **Identity-mapping custody — open, clarified in §5.3.** Candidate mechanisms: the org's admin console holds the pseudonym table, or an org-held key derives the IDs so the mapping is never materialized at all. To be decided with the decision-6 design, since enrollment creates the ID.
8. **Pricing — settled:** €12/seat/month billed annually (€144/year), €16/seat monthly (§9). Enterprise rate tables and the works-council pack are standard features, not gates (§6a, §7).

The individual product finds what one developer keeps paying AI to improvise. The enterprise product finds where a whole organization does — and gives its leadership the evidence to fix the process instead of grading the people.
