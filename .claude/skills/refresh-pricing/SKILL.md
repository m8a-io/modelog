---
name: refresh-pricing
description: Audit data/pricing.json against Anthropic's and OpenAI's current published list pricing, and report gaps or drift. Use when the user says "refresh pricing", "update pricing data", "check for new model pricing", "price audit", "is our pricing current", or a model shows as unpriced/unavailable in the dashboard.
---

# Refresh pricing

`data/pricing.json` is the only static rate table in Modelog, and it prices exactly two vendors: Anthropic (`claude-*`, consumed by Claude Code) and OpenAI (`gpt-6*`, consumed by Codex). **GitHub Copilot is out of scope for this skill** — Copilot self-reports its own rate card per session (`src/ingest/copilotCard.ts` reads `billing.token_prices` from each session's `models.json`), so there is no static Copilot table to refresh.

This skill **reports findings only**. It does not edit `data/pricing.json`, bump the version, or touch the CHANGELOG — hand the report to the user and let them decide what to apply, since a wrong rate here silently misprices real turns.

## 1. Read the current table first

Read `data/pricing.json` and `src/metrics/cost.ts`'s `PricingFile` interface doc-comment so you know the current shape: `ratio_scale`-based integer multipliers (never decimals), per-model `cache_read` overrides (default is the uniform `cache_multipliers.cache_read`), and the optional `long_context` tier (currently only `claude-haiku-5-5`).

List every model id currently in `models`, split by vendor prefix (`claude-*` vs `gpt-6*`).

## 2. Dispatch one research agent per vendor, in parallel

Use the Agent tool (general-purpose), not WebFetch directly in the main thread — each agent needs to cross-check several pages and a long tool-call trace would bloat the main context for no benefit.

Give each agent:
- The exact current model ids and rates from step 1, spelled out (so it can diff rather than re-derive from scratch).
- The source URLs to check:
  - Anthropic: `https://platform.claude.com/docs/en/about-claude/pricing` (full card), `https://platform.claude.com/docs/en/about-claude/models/overview` (to confirm exact API id strings for anything new)
  - OpenAI: `https://developers.openai.com/api/docs/pricing`, plus the specific `https://developers.openai.com/api/docs/models/<id>` page for any model that looks new or changed
- An explicit instruction to flag:
  1. Any model id used by real session logs that has **no entry at all** (this is the highest-severity case — it shows as "cost unavailable" in the dashboard, not just a wrong number). If the user reported a specific unpriced model, name it explicitly and make confirming its exact API id and rate the agent's first priority.
  2. Any rate that changed from what's currently in the table.
  3. Any model with a non-default `cache_read` ratio (the card sets this per-model — several `claude-*` entries already override it; don't assume the 0.1x default applies to a new model without checking).
  4. Any model with a prompt-length / long-context pricing tier (so far unique to `claude-haiku-5-5` on the Anthropic side; OpenAI publishes a long-context tier on GPT-6 models above ~272K input tokens that Modelog does not currently model at all — worth re-flagging each time until someone decides whether to implement it).
  5. New model ids in the GPT-6 / Claude families that Codex or Claude Code might start writing into logs, even if no current session uses them yet.
- Instruction to cite the exact URL(s) and today's date for each figure, and to report in a structured per-model table (id, input $/1M, output $/1M, cache_read $/1M or ratio, long-context tier if any, changed-from-current yes/no).

Run both agents in parallel (single message, two Agent tool calls) and wait for both before synthesizing — don't duplicate their web research yourself.

## 3. Synthesize into a report, not an edit

Compile the two agents' findings into one report for the user:

- **Gaps** (model used in logs or named by the user, but absent from the table) — highest priority, call out the exact missing id.
- **Changed rates** — old value → new value, cited source.
- **New cache-read overrides or long-context tiers** worth adding.
- **No change** — a one-line confirmation for everything that matched, so the user knows it was actually re-checked rather than skipped.

For anything you recommend changing, include the literal JSON snippet (in the file's existing style — integer ratios over `ratio_scale`, not decimals) so applying it is a copy-paste, not a re-derivation. But do not write it to the file yourself unless the user explicitly asks you to apply it after reading the report.

## 4. If the user asks you to apply a finding

That's a separate step outside this skill's default scope — at that point follow the normal edit → `npm run check` → CHANGELOG entry → version bump → release-flow conventions in the root `CLAUDE.md`, the same way any other pricing fix would go out.
