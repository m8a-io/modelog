# Modelog in the AI coding factory

**Status:** research notes and proposal; no implementation commitment. Started 2026-11-15.

**What this is.** Modelog was built for one developer watching one agent in one VS Code window and
making subjective calls on the result. Teams are moving to autonomous agents run as a pipeline:
agents implement and review, and humans approve only what a risk gate flags, or nothing at all.
This document collects what that model looks like in general, then works out how Modelog would
measure it, centrally by reading from a team's CI/CD.

Claims are tagged **[verified]** where checked on this machine or against code, and **[untested]**
where they depend on a platform, API or spec not checked here. Don't turn an `[untested]` claim
into a design commitment without verifying it first. Where this document and `PRD.md` disagree,
the PRD wins. The §8.0 invariants apply unchanged, and §8.4 below shows they shape the
integration more than anything else does.

---

## 1. The factory model: control sits in the gates

In automated coding the conversation becomes a pipeline. Each step is a station with an input,
an output and a check:

```
intake → triage/spec → plan → implement → verify → AI review → gate → merge queue → deploy → observe
   ▲                                                                                    │
   └──────────────────────── regressions, alerts, new issues ───────────────────────────┘
```

Nobody watches the agent work. Control comes from four places:

| Control | What it does |
| :--- | :--- |
| **Contract at intake** | Spec and acceptance criteria, ideally a test that fails until the work is done |
| **Mechanical checks** | CI, types, lint, security scans |
| **Independent review** | A different agent with fresh context. An agent grading its own work is close to worthless |
| **Risk-tiered gate** | Some changes merge automatically; others wait for a human |

At high volume (reports of going from hundreds to thousands of merges a day) two further pieces
carry most of the load:

- **The merge queue** re-tests each change against current main, so two changes that each pass
  alone can't break main together.
- **The deploy side**: feature flags, canaries and automatic rollback catch and reverse a bad merge
  before most users see it. The human gate is one layer of defence, not the last one.

## 2. Task types

| Type | Examples | Verifiability | Typical automation |
| :--- | :--- | :--- | :--- |
| **Build new** | Feature, improvement, new app | Low: "correct" is a product judgment | Human owns the spec; agents implement pieces |
| **Fix old** | Bug, reported issue | High when a test reproduces it | Agent does most of it, including the repro test |
| **Maintain** | Dependency bumps, migrations, refactors, flaky tests, lint sweeps | Very high: behaviour must not change | Most likely to be auto-merged |

The dividing line that matters is **how well-specified and verifiable** a task is, not whether
it's new or old work. A bug with a failing test is a closed problem. "Add team billing" is an open
one with many decisions only a human can own.

**Running types concurrently.** Teams do run fixes and features at the same time. What must be
kept apart is the *area of code*, not the task type. The protections are one isolated environment
per task (worktree, container, RDE), small changes, and the merge queue as the backstop for
changes that don't conflict line by line but still break each other. A sensible order for adopting
automation is maintain → fix → build, from most verifiable to least.

## 3. Why run multiple agents

1. **Parallel independent work.** N tickets, N agents, N sandboxes. This is where the volume comes from.
2. **Role separation.** Planner, implementer, tester, reviewer. The point is independence, not speed.
3. **Breaking down big work.** A planner splits a feature or migration into small, separately
   verifiable changes and fans them out.
4. **Multiple attempts.** The same task run N times, possibly on different models; keep the best
   result that passes. Costly, but strong on hard bugs.

There's also standing work with no human trigger: triage (labelling and reproducing incoming
issues), dependency upgrades, fixing flaky tests.

## 4. Authority

### 4.1 The autonomy ladder

| Level | Agent may… | Human does… |
| :--- | :--- | :--- |
| 0 | Suggest | Everything else |
| 1 | Implement in a sandbox, open a PR | Reviews and merges every PR |
| 2 | Have low-risk change classes auto-merged | Reviews what the gate flags |
| 3 | Choose its own work from a triaged backlog | Sets priorities and boundaries |
| 4 | Deploy | Watches outcomes and rollbacks |

How much authority a change can be given depends on **blast radius** (auth, payments, migrations,
infrastructure, public API), **reversibility** (a code revert is cheap; a dropped column or a sent
email is not) and **verifiability** (test coverage).

### 4.2 The agent never decides its own review tier

The gate classifies from the diff: paths touched, size, new dependencies, schema changes, deleted
or weakened tests. Ordinary forge machinery enforces it: CODEOWNERS, branch protection, required
checks. An agent may **escalate** ("flag this for a human"). It may never **de-escalate**.

### 4.3 Getting stuck

Good reasons for an agent to stop and ask: ambiguous or contradictory requirements, a needed product
decision, tests that pass only if the tests are changed, an exhausted budget (turns, cost, time),
an irreversible next step, or missing credentials.

**Models are better at doing than at knowing when to stop.** Left alone they tend to push through
to something plausible, such as a quietly loosened test assertion. "Knowing not to decide" is
therefore enforced from outside the model: permissions (no production credentials, no force-push,
tool allowlists), budgets, explicit escalation instructions, and the gate. Instructions shape
behaviour; permissions and gates are what guarantee it.

---

## 5. What Modelog measures in a factory

Same thesis, "what changed when we switched models", but judged by **outcomes** instead of a
developer's impression. Pipeline runs are also far more uniform than individual developers, which
makes model comparisons cleaner.

| Signal | Definition sketch |
| :--- | :--- |
| Cost per merged change | All sessions joined to a PR (implement, review, fix-up rounds) ÷ PRs that merged |
| Rework rounds | Implementer sessions after the first review on the same PR |
| Escalation rate | Sessions ending in "needs input" vs. pushing through |
| Review catch rate | Reviewer-requested changes per PR, by implementer model |
| Gate outcome | Auto-merged / human-approved / human-rejected, by model and tier |
| Revert rate | Merged changes later reverted, by model |
| Abandonment | Tasks whose PR closed unmerged, or that never produced one |
| Model per station | Each signal above, split by role |

Each still respects invariant 5: costs in different vendor units are never compared with each other.

---

## 6. Injecting Modelog into CI/CD

### 6.1 Integrate with the forge, not with every CI system

CI/CD pipelines vary widely (GitHub Actions, GitLab CI, Jenkins, Buildkite, CircleCI, in-house).
**The outcomes listed in §5 mostly live in the forge, not in the CI system**: PR opened, reviews,
check results, merge, revert commits on main. CI systems report back to the forge as check
statuses either way. So the integration surface is one per forge (GitHub, GitLab, Bitbucket,
Azure DevOps), not one per pipeline.

Deploy and rollback events are the exception. They live in CD tooling and are the least
standardised. Treat them as later and optional (§6.6).

### 6.2 Three capture points

```
 where the agent runs                     the forge                       Modelog backend
 (CI runner, RDE, laptop)                (GitHub/GitLab)
┌──────────────────────────┐        ┌──────────────────────┐
│ modelog run -- <agent>   │        │ PR, reviews, checks, │
│  usage rows, no content  │──┐     │ merge, revert        │
│  + join keys + role      │  │     └──────────┬───────────┘
└──────────────────────────┘  │                │ read by a customer-side step
                              │     ┌──────────▼───────────┐
                              │     │ modelog outcome      │
                              │     │  derives fields,     │
                              │     │  drops content       │
                              │     └──────────┬───────────┘
                              └────────────────┴───────────▶  join on keys → §5 signals
```

**A. Usage, where the agent runs.** A wrapper around the agent invocation:

```
modelog run --role implementer --task ISSUE-123 -- claude -p "…"
```

The wrapper knows the start and end of the run, collects the session log the agent wrote, parses
it with the **existing `src/ingest/` adapters and `src/metrics/` cost engine** (they import no
`vscode` **[verified]**), and uploads allowlisted rows. A GitHub Action or GitLab component is just
a thin layer around this command. The same binary covers RDEs and laptops, so the VS Code extension
becomes one collector among several.

- Whether headless `claude -p` and `codex exec` write the same JSONL as interactive sessions:
  **[untested]**. Every Claude Code session on this machine is `entrypoint: "claude-vscode"`
  (4,567 records) and the CLI isn't installed here.
- Whether the agent reports its session id on exit (e.g. Claude Code's JSON output mode), so the
  wrapper can pick the exact log instead of guessing by time: **[untested]**.

**B. Join keys, which connect usage to a change.** This is the hard part. The collector records
several keys, because each one breaks in some workflow:

| Key | Breaks when |
| :--- | :--- |
| Repo + head branch | Branches get reused or renamed |
| Commit SHAs produced in the session | Squash or rebase merges rewrite SHAs |
| PR number, looked up from SHA or branch through the forge API | Work that never becomes a PR (still worth counting as abandonment) |
| Task id (issue, ticket) passed to the wrapper | The pipeline doesn't pass one |
| Commit trailer, e.g. `Modelog-Session: <id>` | Squash commits drop or rewrite messages, depending on repo settings **[untested]** |

The backend joins on whichever keys are present, and reports unjoined sessions as unjoined rather
than guessing. That's the same visible-gap rule as invariant 3.

**C. Outcomes, from the forge.** A customer-side step reads forge events and emits derived records:
PR opened, review verdict, check conclusion, merged by gate tier, closed unmerged, reverted.

### 6.3 Roles come from the pipeline, not the agent

A session doesn't know whether it's the implementer or the reviewer; the pipeline does. The
wrapper takes `--role` (or reads it from an environment variable the pipeline sets). Without it,
"model per station" can't be measured. A session with no role is recorded as role unknown, never
guessed.

### 6.4 The content boundary decides the architecture

Invariant 1 says any backend **never reads content**, and §8.0 makes **"never transmitted"
absolute**. Forge webhook payloads carry PR titles, descriptions and commit messages, and diffs are
one API call away. So:

- **No forge webhooks point at Modelog's servers.** Receiving content and discarding it still
  counts as transmitting it.
- **Fields are derived on the customer side.** The `modelog outcome` step runs inside the customer's
  CI with the repo access it already has. It reads the event, derives only allowlisted fields
  (numbers, SHAs, timestamps, states, tier labels) and sends those. Example: detecting a revert
  means reading the `This reverts commit <sha>` message. The step reads it locally and sends only
  `{reverted_sha}`.
- **The upload payload is allowlisted** the same way `src/diagnostics/` builds the bug report, and
  tested the same way.

**The step reads content, and §8.0 already covers that.** It reads commit messages locally, which
puts it in the same position as the MCP/Ollama engine: §8.0's "never read" is scoped per component
and may be relaxed where needed, while "never transmitted" and "never persisted" stay absolute. The
step needs its own entry in that per-component list.

**Considered and declined 2026-11-15:** relaxing "never transmitted" to allow opt-in content
transmission. See §8 Q6 for why.

This is exactly the extension's existing pattern, moved into CI: read the raw artifact locally,
keep only derived fields. A team that wants webhooks instead of a CI step could run a self-hosted
relay that applies the same allowlist before anything leaves its network.

**File paths are an open question.** Risk tiers are usually defined by path, and paths can
themselves be sensitive (`services/acquisition-target-x/`). Proposal: the customer configures
path → tier rules locally, and only the tier label is sent.

### 6.5 What this can't see

- **Vendor-hosted cloud agents** (Copilot coding agent, Codex cloud, Claude Code on the web) run on
  the vendor's infrastructure and leave no session log for Modelog to collect. *Corrected
  2026-11-15:* the vendors do publish usage, but only aggregated. Anthropic's Usage and Cost
  Admin API (Console orgs: grouped by model, API key, workspace) and Analytics API (Enterprise:
  per user, product and model, hourly buckets, 1–3 h latency), and GitHub's Copilot usage metrics
  API (org-level daily and 28-day totals, including tokens). All **[untested]** here. None of it is
  per session, so none of it joins to a PR. Claude Code's teleport pulls a web session's full
  history down to a local terminal **[untested]**, but that's manual, one session at a time.
  **Decision 2026-11-15:** teams that run their agents on vendor infrastructure are outside
  Modelog's factory scope. Coarse aggregate-only reporting stays possible later; it isn't planned.
- **Pipelines that don't pass a role or task id** degrade to repo-level, role-unknown figures.

### 6.6 Standards to check before inventing a schema

- **OpenTelemetry CI/CD semantic conventions** (`cicd.*` attributes for pipelines and runs):
  **[untested]**, maturity and coverage unknown.
- **CDEvents** (CD Foundation spec for interoperable CI/CD events, including deploy events):
  **[untested]**, adoption unknown.
- **Claude Code's own OTel export** (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP exporters, documented
  as beta) is an alternative usage source for capture point A when real-time matters. Only covers
  Claude Code. **[untested]** here.

If either CI/CD standard has real adoption, outcome records should be expressible in it instead
of in a Modelog-specific schema.

---

## 7. Parked topics

Noted so they don't get lost. Out of scope for this document.

- **Automating m8a's own maintenance work** (dependency and library upkeep): §2's "maintain"
  category, applied to m8a.
- **Compute cost of the factory.** RDEs and CI runners grow with automated volume just as token
  spend does. Cost per merged change is incomplete without compute, and m8a needs to meter it to
  charge for it. Compute and token money are different units, so invariant 2's rule against summing
  across units applies.

## 8. Open questions

1. Do headless agent runs write the same session logs as interactive ones? (§6.2 A, first thing to verify)
2. Which join key survives each merge strategy (merge, squash, rebase) on GitHub and GitLab?
3. Path-based tiers without transmitting paths: is a locally configured tier label enough?
4. Where does the factory product live: the public repo's ingest code plus a new CLI entry point,
   with the backend in the private repo per the website split?
5. Is the first target GitHub only, and what's the minimum (usage + merge/revert) that produces a
   useful model comparison?
6. ~~Should §8.0's "never transmitted" become "never transmitted unless the user or enterprise
   admin has clearly opted in, and only what the analysis needs"?~~ **Resolved 2026-11-15: no,
   the invariant stays.** Installing a collector is consent to usage telemetry, not to content.
   In the enterprise case the admin consents on behalf of developers whose prompts are at stake
   (works-council and GDPR exposure, not yet checked with counsel). And data minimisation already
   leads to zero transmitted content, since every §5 signal can be derived locally. Revisit only
   when a specific signal provably needs a transmitted field, and then add a narrow, explicit,
   named opt-in for that field, never one implied by installation.
