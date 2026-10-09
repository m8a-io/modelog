# Automated OpenAI and Claude price updates

**Status:** Future workflow proposal; no monitor or publishing job is running.

**Research date:** 2026-10-09.

Modelog needs current, traceable model prices for its cost analysis to be useful. The proposed workflow checks OpenAI and Claude's official API price cards, turns an actual rate change into a validated update of Modelog's pricing data, and publishes a new extension version when that update is ready. Routine checks with no price change produce no release. GitHub Copilot is outside this workflow: Modelog uses the credit rate card stored beside each Copilot session, and its public credit price is not part of this request.

## Recommended cadence

Run the monitor **once per day**, with a manual run option. Price changes appear infrequent, so a daily check gives a practical target of detection within roughly a day without tying releases to a calendar. **Publish on a verified data change**, not weekly or monthly. If a shorter detection window later matters, increase the check frequency without changing the release rule. A missed or failed check must be visible; [GitHub notes](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) that scheduled Actions can be delayed or dropped under load and disabled in an inactive public repository.

These are separate clocks: the check interval determines how soon Modelog notices a change; the vendor's **effective date** determines which rate applies to a turn; the publish time determines when users receive corrected data. Publishing faster cannot compensate for assigning the wrong effective date.

## Sources and the change event

| Vendor | Current rate source | Change context |
| :--- | :--- | :--- |
| OpenAI | [API pricing](https://developers.openai.com/api/docs/pricing) | [API changelog](https://developers.openai.com/api/docs/changelog) |
| Claude | [Claude pricing](https://claude.com/pricing#api) and [detailed API pricing](https://platform.claude.com/docs/en/about-claude/pricing) | [Claude Platform release notes](https://platform.claude.com/docs/en/release-notes/overview) |

The monitor should extract the relevant price tables and compare **normalized rates**, not raw page HTML. A heading, navigation, or layout edit is not a price change. The normalized record needs the vendor, exact model ID, currency and unit, input and output rates, cache read and write rates, processing tier, context tier or threshold where applicable, and source URL. Keep the fetched evidence and retrieval time with the proposed update. Detect added or removed model rows as well as changed values; a new model may be relevant even when every old price is stable.

The price card establishes the current number. A release note or changelog may establish when it took effect; the two can disagree or be published at different times. If the effective date is not verifiable, the checker should open an exception for review rather than silently treating the check time as the effective date. The [October 7, 2026 Claude release note](https://platform.claude.com/docs/en/release-notes/overview) changing Sonnet 5.5's cache-read price is an example of why input and output rates alone are insufficient.

## Proposed CI flow

```text
daily page monitor or manual run
  -> fetch and compare normalized official prices
  -> no semantic change: record a healthy check and stop
  -> semantic price change: dispatch pricing-update CI
  -> refetch, verify, generate dated rate-data update and evidence
  -> run pricing checks, full CI, and package validation
  -> merge accepted update -> publish a uniquely versioned extension
```

The simplest first implementation is a scheduled GitHub Actions monitor in this repository that dispatches a separate pricing-update workflow only when normalized prices change. An external page monitor could instead call GitHub's [`repository_dispatch`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch) event to start that same workflow. In either case, the event is a signal to fetch and verify the official page again, not a trusted price value. Network access stays in CI, outside the local extension, consistent with [PRD §8.1](PRD.md#81-privacy--local-first).

The update job should produce a small, reviewable change: the old and new rates, affected model and dimensions, effective date, URLs, retrieval time, and a diff to [`data/pricing.json`](../data/pricing.json). It should rerun the extraction before generating the update to catch transient page errors. No change means no branch, version bump, package, or release. A failed fetch, empty table, duplicate model ID, unsupported unit, or unexpected schema produces a failed check and maintainer notification; it never becomes a zero or default rate.

The eventual automatic path can accept an update **only when** the changed dimensions fit the existing schema, the source and effective date are clear, the second extraction agrees, and all pricing and package checks pass. New pricing dimensions, ambiguous announcements, model-ID mapping changes, or contradictory sources need review. That is an exception path for uncertain data, not a requirement to manually approve every ordinary price update. When a change is accepted, merge it and let the release workflow publish once. Keep detection credentials separate from publishing credentials.

The repository currently has [CI checks](../.github/workflows/ci.yml) and `npm run package` / `npm run publish`, but no automated release workflow. The accepted update should include a unique extension version. The release workflow must build and test that exact merged commit, package the VSIX, and publish it to the VS Code Marketplace. [VS Code's publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) documents `vsce` and recommends Microsoft Entra ID for automated publishing; its documentation says global Azure DevOps PATs retire on December 1, 2026. The release path needs a verified publishing identity before automatic merging is enabled.

GitHub's default `GITHUB_TOKEN` has a workflow-triggering caveat: a push it creates generally does not start another `push` workflow. Use a documented [dispatch event or GitHub App token](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow), or keep update and publish in an explicitly connected workflow. Do not assume a bot commit will start the release job.

## Pricing correctness before automatic releases

Today's `pricing.json` is one versioned snapshot. The Claude and OpenAI cost engines apply it to historical turns, so changing the file can silently reprice past sessions. [PRD open question 18](PRD.md#11-open-questions--risks) already tracks the fix: resolve effective-dated rate intervals at the turn level. **This is a prerequisite for automatic price-triggered publication.** The pipeline must retain old intervals, add the new rate at the verified effective date, and leave turns before that date on their prior rate. A resumed session can cross a price boundary.

The current schema also cannot be assumed to express every future rate. OpenAI publishes processing and context tiers; Claude publishes cache-write durations, geography or speed modifiers, and some model-specific thresholds. If an official change introduces a dimension Modelog cannot represent or a value the logs cannot identify, the affected turns must remain cost unavailable under [PRD §8.0](PRD.md#80-invariants--the-rules-that-must-not-break) until the engine and data model can price them correctly. An apparent base-rate update must not erase these distinctions.

## Validation and rollout

Before enabling automatic publishing, prove the workflow with recorded examples: a real price change, a new model, a cache-only change, a future effective date, a page redesign, and a failed fetch. Check that unchanged pages create no releases, a confirmed change updates only the intended rates, and costs on either side of its effective date differ correctly. Package and install the produced VSIX in a test environment before enabling Marketplace publication. Track the time of the last successful check and last published rate update so a silent monitor failure is visible.

Start with monitor runs and generated review branches. Once effective-dated pricing, parser checks, and publishing are proven, enable automatic merge and release for the clear cases above. The resulting release pace is driven by real vendor price changes, while the daily checks keep Modelog ready to notice them.
