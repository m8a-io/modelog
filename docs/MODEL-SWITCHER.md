# Modelog Model Switcher

**Status:** Proposal for review; no implementation commitment.

**Research date:** 2026-10-09.

Modelog should be able to recognize an upcoming task and automatically select the user's preferred model **before that task starts**. The reasons for switching must be entirely user-defined: the user decides what constitutes a task, which signals matter, which conditions cause a switch, and which model should handle the work.

Modelog is currently an analytics tool. This feature would add an optional control capability alongside its analytics. It does not require Modelog to become an agent. The intended experience is to keep working in Claude Code, Copilot, or Codex while Modelog applies the user's model-selection policy where the host supports it.

Two mechanisms can apply a policy, and they differ sharply in feasibility and cost:

1. **Sub-agent delegation (recommended primary mechanism).** The parent session stays on the model the user chose for the main goal. Side work the user names, such as git housekeeping or GitHub issue and PR operations, is handed to a sub-agent defined with a cheaper model. See [Primary mechanism](#primary-mechanism-delegate-side-work-to-sub-agents).
2. **Swapping the session's own model between tasks.** This is the original proposal and is described in the rest of this document. It needs a pre-dispatch barrier that most hosts do not expose, and it discards the prompt cache (see [Analytics and explainability](#analytics-and-explainability)).

Sections that describe task detection, a pre-dispatch barrier, or per-session model control apply to mechanism 2 unless they say otherwise.

## Motivation: make behavior changes repeatable and measurable

Modelog grew from wanting to understand the effects of changing one's own development behavior. One example is deliberately switching models more often to match different tasks, primarily within the same session and also across sessions. The question is whether that change in working habits makes a useful difference.

The model switcher gives developers a clear method for putting such a change into practice. A developer can express an intended behavior as rules, have Modelog apply those rules consistently, and use Modelog's analytics to examine what happened. Automation reduces the need to remember each manual switch while preserving the developer's control over the behavior being tried.

The intended cycle is: observe current behavior, define a change, apply it, review the resulting behavior and measurements, and refine or revert the rules. More frequent switching is one possible experiment, not a success metric in itself. Users may ultimately choose fewer switches or different task-to-model mappings.

For example, a developer who normally uses one model throughout a session could define separate selections for planning, implementation, and review. As those tasks begin in the same conversation, Modelog would apply the selections and record which changes actually occurred. The developer could then compare that pattern with their previous practice, subject to the limits of the available measurements.

## Primary mechanism: delegate side work to sub-agents

### The behavior change

Most of a coding session's expense is not the feature being built. It is the side work around it: committing, pushing, opening a PR, reading an issue, triaging CI output. That work is mechanical, yet it runs on the most capable and most expensive model, and its output (diffs, `git status`, `gh` JSON, logs) fills the parent's context for the rest of the session.

The intended behavior change is for the parent model to hand that work off:

> “When the work is *this kind of side task*, delegate it to a sub-agent on *this cheaper model*, and return only a short result. Keep the parent focused on the main goal.”

Two benefits follow, and the second is probably the larger one:

- **Price.** Mechanical steps run at a lower per-token rate.
- **Context.** Side-task output stays in the sub-agent's own context. The parent receives a summary, so its context grows more slowly. Fewer input tokens per parent turn means lower cost and less noise around the main task.

### Why this beats swapping the parent's model

- **The cache survives.** Prompt caches are model-specific (see the Claude [model configuration](https://code.claude.com/docs/en/model-config) documentation). Swapping the parent's model means its next request re-reads the whole context uncached, so a swap for a short side task can cost more than it saves. A sub-agent has its own context, so the parent's model and cache are untouched.
- **No pre-dispatch barrier.** Mechanism 2 requires Modelog to hold the first inference until the switch is acknowledged, which most hosts do not allow. Delegation needs only host configuration written before the session.
- **Broader host reach.** Each host has some form of user-defined sub-agent or custom agent. The details differ and are `[untested]` here: Claude Code agent definitions with a `model` field, Copilot CLI custom agents and `/subagents`, and Copilot in VS Code custom agents. Codex support is unknown. Validate each against current documentation and installed versions before promising support.

### How Modelog would apply it

Modelog would generate and maintain agent definitions and delegation instructions in the host's own configuration, for example a "git" agent on the user's cheap model, plus a short rule in the host's instruction file (`CLAUDE.md`, `AGENTS.md`, or equivalent) saying when to use it. Modelog does not sit in the request path.

- The user defines the side-task categories, the target model for each, and the instruction wording. Modelog supplies editable presets only.
- Writing to a repository or home directory needs explicit consent, a preview of the exact files, and a way to remove everything Modelog wrote. This moves Modelog beyond read-only, so it must be opt-in.
- Rules that exist only in Modelog's policy and not in host configuration have no effect, so the host configuration is the source of truth. Modelog should detect drift between its policy and what is installed.

### The limit: delegation is requested, not enforced

The parent model decides whether to delegate. Instructions raise the likelihood but do not guarantee it. This weakens two goals stated above:

- **“Show me why the model was selected.”** Modelog can show that a rule was installed and that a sub-agent turn used the intended model. It cannot show why the parent chose to delegate or not.
- **“100% user-defined.”** The routing policy is user-defined, but its execution depends on the parent model's compliance.

Strengths of enforcement, from weakest to strongest:

1. A sub-agent description that the host matches against the task. Probabilistic.
2. Explicit delegation instructions in the host's instruction file. Stronger, still probabilistic.
3. Host-enforced routing, such as hooks or permissions that block the side-task commands in the parent and direct the work to the sub-agent. This is `[untested]`, may be unavailable on some hosts, and can frustrate users if it fails. It is also the closest to the barrier problem and should not be assumed.

The product should state the strength actually in effect, and report delegation as an observed rate, never as a guarantee.

### Costs and risks to measure

- **Handoff cost.** A sub-agent starts with no parent context. The parent must pass what the task needs, and a long handoff can erase the saving. Very small side tasks may cost more to delegate than to do directly. Modelog should measure the break-even rather than assume one.
- **Quality of mechanical work.** A cheaper model may mishandle edge cases such as merge conflicts or unusual branch states. Failures that land back on the parent are a cost.
- **Cold start.** The sub-agent's first request is uncached.
- **Parent compliance drift.** Delegation rates may change between model versions or as sessions grow long.

### What the logs already show

Modelog's adapters already distinguish sub-agent turns, with different reliability per source:

| Source | How sub-agent turns are identified | Status |
| :--- | :--- | :--- |
| Claude Code | `isSidechain` on the record. Sub-agent logs sit under `<session>/subagents/` with a `.meta.json` file. | Captured. In the author's data, every sidechain turn is Haiku. |
| Copilot in VS Code | A separate `executionSubagent-*.jsonl` file; `isSidechain` is a property of the file, not the record. | Captured. |
| Copilot CLI | Not captured. `--fleet` mode has not been observed. | Known gap. Treat as unknown, not as zero. |
| Codex | Inferred from the root-turn id and the turn trigger. | Heuristic. Needs validation. |

Consequences for this feature:

- Claude Code's `.meta.json` has an `agentType` field, which is metadata. It also has a free-text `description`, which is content and must not be read or stored under the PRD invariant. Whether the ingest should read `agentType` is undecided.
- Modelog cannot tell from content that a sub-agent turn was “a git task”. Categories must come from agent identity (name or type) or from user-assigned labels, not from reading prompts.
- `developerModelSwitches` already excludes sidechain turns, so delegation is not misreported as the developer switching models. The switcher's analytics need a separate measure for delegation.
- PRD open question 23 (how sidechain turns enter per-model comparisons) becomes a prerequisite, because delegation moves work from the main population into the sidechain population by design.

### What Modelog would measure

- Share of turns and cost that are sidechain, before and after the policy.
- Parent context growth: input tokens per parent turn over the course of a session.
- Parent cache-read ratio, to confirm the cache was preserved.
- Delegation rate per category, where agent identity makes the category observable.
- Total cost including sidechain turns, within one source and one money unit.

These comparisons are observational. They do not show that quality was unchanged or that the policy caused a saving. Sub-agent and parent turns have different prompt shapes and cache behavior, so per-turn figures must not be blended.

## Product goal

The desired behavior is:

> “When I am about to do this kind of work, under these conditions, use this model. Apply my rules automatically, and show me why the model was selected.”

The following are requirements from the feature request:

- Detect relevant tasks before execution and switch before their first model request.
- Let users define all switching criteria and task categories. Modelog must not impose a fixed definition of which model is best for a task.
- Support changes to those rules as the user's work, preferences, and available models change.
- Make the reason for every automatic selection inspectable.
- Prioritize switching between tasks within an existing session, while also supporting policies across sessions where feasible.
- Connect policy activation and changes to analytics so developers can review whether their intended behavior occurred and how the measured results differ.

The mechanisms below are proposed ways to meet those requirements. Their details remain open for review.

### What counts as a task

A useful initial boundary is a submitted user request: one task begins when the assistant makes its first inference for that request. Modelog must finish selection before that inference. Detecting a task from a completed turn's logs is too late.

A single request can contain several activities, such as planning, implementation, and testing. Switching between those activities requires the host to expose additional boundaries. Internal tool calls and follow-up turns should not automatically be treated as new routing opportunities without an explicit policy and corresponding host support. Sub-agent turns are not routing opportunities for the parent's model either; under the delegation mechanism they are the intended outcome, and they are measured separately.

Switching within the same session is the primary use case. Whether its task boundaries correspond to individual requests or host-defined stages remains a product decision. A session-only implementation would not fulfill that primary use case.

## User-defined switching policy

Task detection and model selection should be separate. A detector produces a signal such as a task label; a user-defined rule decides what to do with it. An optional classifier must not silently become the authority on which model to use.

Users should be able to configure:

| Policy element | User control |
| :--- | :--- |
| Task definitions | Create, rename, combine, and remove categories and their detection criteria. |
| Inputs | Choose which available signals may influence decisions. |
| Conditions | Combine task, assistant, workspace, session state, and other supported signals. |
| Target | Select a specific available model or a user-defined alias resolved separately for each assistant. |
| Scope and precedence | Define personal, workspace, or session rules and resolve competing matches explicitly. |
| Uncertainty and failure | Decide what happens on no match, uncertain detection, unavailable models, or failed switching. |
| Duration | Decide whether a selection persists, applies to one task where supported, or returns to a previous model. |
| Overrides | Pause automation or hold a manual model selection for a defined scope. |
| Switching frequency | Configure any cooldown or minimum interval, rather than accepting an undisclosed optimization. |

For example, a user could define “documentation task → my fast model,” “architecture review → my reasoning model,” or “explicit review label → my review model.” These are examples, not mandatory categories or Modelog's judgment about model quality.

Optional presets should be editable and removable. Analytics may suggest a rule, but adopting or changing it remains the user's decision. There should be no hidden routing rules or automatic policy changes based on inferred preferences.

Dynamic behavior means evaluating current inputs against the current policy at each supported task boundary. Edits should take effect at the next boundary, with the policy version recorded for each decision. Model availability should be refreshed where the host allows it. An unavailable target must trigger the user's fallback policy, not an undocumented substitution.

“100% user-defined” describes routing policy. It cannot override account entitlements, administrator restrictions, missing host APIs, or uncertainty in classification. Those limits must be visible.

## Detecting work before it starts

Potential inputs include explicit task labels, commands, a selected workflow or mode, workspace identity, branch names, and metadata made available by the host before submission. Their availability differs by integration; none should be assumed universally accessible.

Existing Modelog usage logs primarily describe work already performed. Tool activity, retries, duration, and files changed can help categorize past work, but cannot identify the first task request in time to route it. Previous activity may inform a subsequent task only when the user's policy allows that inference.

Interpreting the natural-language request itself would provide another detection method, but it raises a specific privacy decision. The [PRD](PRD.md#80-invariants--the-rules-that-must-not-break) prohibits the extension and store from reading prompt or code content, while allowing a separately scoped, optional local inference component to process content under stated constraints. Its session-labeling design also starts with metadata.

The proposed default is therefore metadata and explicit labels. Semantic detection would need a separate design for an opt-in local component, access to the pending request, and a guarantee that it emits only derived classification data to Modelog. Prompt or code content must not enter the analytics store. Sending requests to a cloud classifier would depart from the current local-processing constraints and is not part of this proposal.

The fixed categories and pinned classifier discussed for comparable analytics in PRD §7.7–7.8 must not constrain user-defined routing categories. Analytics labels and routing labels may need distinct representations.

## Applying a decision before execution

A reliable integration needs two capabilities: control over the selected model for the intended session, and a way to hold task dispatch until selection is complete. A model setter alone does not prove the full feature is feasible.

The proposed sequence is:

1. Receive a pending task event with an unambiguous session identity, before inference begins.
2. Collect permitted signals and evaluate a snapshot of the user's rules.
3. Resolve the target against the models available to that host and account.
4. Apply the selection to the intended session or pending request and obtain acknowledgment.
5. Release the task, or follow the user's configured failure policy.
6. Observe the actual model used, where telemetry permits, and record any discrepancy.

If a host cannot intercept or cooperatively delay submission, Modelog can offer recommendations or best-effort changes, but must not present those as guaranteed automatic switching before the task starts.

Concurrent sessions require separate state. A delayed switch must not affect another session, a canceled request, or a newer task. Manual model changes and policy edits during a pending decision need explicit precedence. The proposed default is to apply automation at the next task boundary rather than alter an inference already in progress.

Users should have a dry-run mode showing what would switch and why, followed by opt-in automation for supported integrations. This is proposed product behavior, not a requirement to approve every individual switch.

## Integration research

The evidence below combines official documentation, source inspection, and local package inspection. It establishes candidate control mechanisms; none has yet been validated end to end as Modelog routing an existing user's task before its first inference.

| Surface | Model control found | Feasibility for this feature |
| :--- | :--- | :--- |
| Codex app-server | Experimental settings update for an existing thread in local version 0.162.0. | Strongest candidate for a prototype. Session access and a pre-dispatch barrier still need validation. |
| Copilot native VS Code chat | Commands cycle models or open the picker for the last focused chat. | Insufficient evidence for reliable selection of an exact model in a named session. |
| Copilot CLI / SDK | SDK methods change a session's model. | Candidate for sessions accessible through that runtime; does not establish control of native VS Code chat. |
| Claude Code native VS Code extension | Internal model-setting path, but no external setter found in installed version 2.1.251. | Needs a supported integration path before reliable external automation can be claimed. |
| Claude Code terminal / Agent SDK | Live `/model` command; SDK model control for accessible SDK sessions. | Separate integration possibilities, each with access and timing constraints. |

### Codex

The installed Codex CLI and running app-server reported version **0.162.0**. Locally generated experimental protocol types expose `thread/settings/update`, accepting a thread ID and a model override for subsequent turns, plus a `thread/settings/updated` notification. The same methods were absent from protocol types generated without experimental features.

Illustrative request, not an executed switch:

```json
{
  "method": "thread/settings/update",
  "id": 1,
  "params": {
    "threadId": "<existing-thread-id>",
    "model": "<available-model-id>"
  }
}
```

The generated protocol also contains experimental `turn/settings/update` for a running turn. That is a distinct capability: changing an already-running turn does not satisfy selection before task start, and its documented limitations include unchanged child sessions and consumers of frozen initial settings.

The inspection is reproducible with the matching CLI version:

```sh
codex --version
codex app-server generate-ts --out /tmp/modelog-codex-protocol --experimental
codex app-server generate-ts --out /tmp/modelog-codex-stable-protocol
```

Official [app-server documentation](https://learn.chatgpt.com/docs/app-server) describes client transports, experimental API negotiation, and model overrides on `turn/start`. Those overrides are useful when an integration controls submission. They do not establish that Modelog can intercept another client's pending request. The documented [IDE command surface](https://learn.chatgpt.com/docs/developer-commands?surface=ide) does not expose an equivalent model-setting command.

**Assessment:** prototype against the app-server, with capability checks and experimental-version handling. Validate that Modelog can reach the intended existing thread, synchronize with the user's client, and prevent its first request from racing ahead of the change. Do not assume every Codex IDE client uses the inspected shared daemon.

### GitHub Copilot

VS Code's [chat action source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatExecuteActions.ts) includes `workbench.action.chat.switchToNextModel`, `workbench.action.chat.switchToNextPinnedModel`, and `workbench.action.chat.openModelPicker`. These act on the last focused chat widget. They do not take an exact target model and session as arguments.

An extension can invoke commands, but cycling through a changing model list is not a reliable exact-selection API. VS Code's [Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model) lets an extension select models for its own requests; it does not change the model selected in an existing Copilot chat. Source on the moving `main` branch also needs validation against the user's installed VS Code version.

The separate Copilot SDK documents `session.setModel()` and `session.rpc.model.switchTo()` in its [compatibility reference](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility). Its [debugging guidance](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/debugging) describes connecting to an existing CLI server. These provide a different possible integration surface; they do not establish access to native VS Code chat sessions.

**Assessment:** distinguish native chat from CLI/SDK support. Native chat needs an exact session-targeted setter and a pre-task interception mechanism. SDK capabilities should not be advertised as native chat control.

### Claude Code

Inspection of the installed VS Code extension **2.1.251** found no contributed model-switch command or returned extension API exposing a setter. Its webview has an internal `set_model` handler that updates settings and applies them to its runtime, demonstrating internal support without exposing a supported cross-extension entry point.

Editing the settings file is not a substitute for that live control. Anthropic's [settings documentation](https://code.claude.com/docs/en/settings#when-edits-take-effect) identifies model selection as a startup setting and directs live changes through `/model`. The [model configuration reference](https://code.claude.com/docs/en/model-config) distinguishes startup `--model` selection from the live command.

Sending `/model` into an integrated terminal is a possible workaround, but requires reliable knowledge of the target terminal, input state, task timing, and acknowledgment. It cannot currently be treated as a guaranteed pre-task switch. SDK control similarly applies to sessions accessible through that SDK; it does not grant access to an arbitrary existing extension session.

The documented [VS Code process-wrapper setting](https://code.claude.com/docs/en/vs-code) suggests a possible launch-time integration experiment. Relaying control through such a wrapper is an untested inference, requires a changed launch configuration, and would not automatically attach to already-running processes.

**Assessment:** native extension support needs a supported external control surface or a separately validated integration. Settings-file edits and terminal injection should not be the foundation of a reliability claim.

## Analytics and explainability

To support behavioral comparisons, policy activation, edits, pauses, and deactivation should create identifiable comparison anchors. Retain the policy version associated with each decision so later edits cannot rewrite the explanation for past behavior. Manual and automatic switches should be distinguishable where their origin is observable; otherwise, report the origin as unknown.

Analysis should separate intended behavior from observed behavior: which tasks matched rules, which switches were attempted, which models were actually used, and where overrides or failures interrupted the policy. Within-session model transitions and task-to-model patterns are central measurements. Aggregating only by session would hide the behavior this feature is primarily intended to change.

Each decision should record the rule ID and version, derived task label, relevant permitted signals, target session, previous model, requested model, timestamps, and outcome. Record classification confidence only where meaningful, and distinguish explicit labels from inferred ones. If actual model usage is observable, store it separately from the requested selection: successful command delivery is not proof of model usage.

A useful explanation would be: “Rule ‘architecture review’ matched your explicit review label; requested your ‘deep reasoning’ model; host confirmed selection.” If usage cannot be verified, say so. Failed switches, fallbacks, manual overrides, and dry-run decisions should remain distinguishable.

Swapping a session's model discards its prompt cache. Claude's [model configuration documentation](https://code.claude.com/docs/en/model-config) describes model-specific prompt caching and the cost of rereading context after a switch, so the next request pays to rebuild the context. This is a design constraint on mechanism 2, not only a reason for switching-frequency rules: a swap for a short task can cost more than it saves, and Modelog should not assume that more switching means lower cost. Sub-agent delegation avoids this cost for the parent, which is a main reason it is the recommended mechanism. Modelog should report cache-read ratio around each switch so the effect is visible.

Comparisons must preserve existing [PRD constraints](PRD.md): explicit monetary units, no cross-vendor cost comparison, unknown prices shown as unavailable, and subscription shadow prices distinguished from bills. Before/after analytics are observational; they do not prove that a routing policy improved quality or caused savings.

The [MCP bridge](MCP.md) is currently read-only. Switching requires a separate control adapter and does not arise simply from exposing analytics over MCP. This proposal does not change the existing MCP contract. Codex also needs appropriate usage observation if its routing outcomes are to appear alongside the currently supported Claude Code and Copilot analytics.

## Feasibility validation and proposed first scope

### Delegation prototype (recommended first)

Validate sub-agent delegation first, because it needs no interception and can be tested end to end with existing logs. A successful prototype must demonstrate:

- A generated agent definition on the user's chosen cheaper model is accepted by the host, with a preview and a clean removal path.
- Given a session with real side tasks (for example commit and push), the parent delegates at an observable rate, and the sub-agent turns appear in the logs with the intended model.
- Parent input tokens per turn and cache-read ratio can be compared against comparable sessions without the policy, with the limits of that comparison stated.
- Failure is visible: when the parent does the side work itself, or the host ignores the agent, the product reports a rate below the expected one, not a silent success.
- The Copilot CLI and Codex gaps in sub-agent capture are either closed or shown as unknown.

Begin with Claude Code, where sub-agent turns are already captured and the author's data already contains them. Delegation to a different vendor's model is not assumed possible.

### Session model swap prototype

The investigation of mechanism 2 should target Codex app-server because it has the strongest evidence for changing an existing thread's model. This is a technical prototype recommendation, not a decision to prioritize Codex commercially.

A successful prototype must demonstrate:

- Discovery and selection of the intended existing session without affecting another session.
- A pending-task hook or cooperative submission mechanism that holds the first inference.
- An acknowledged model change and evidence that the first inference uses the intended model.
- Successive tasks using different rule-selected models within the same existing session, with the transitions available for behavioral analysis.
- Predictable behavior for manual overrides, simultaneous submissions, cancellation, unavailable models, and timeouts.
- Visible failure when the host cannot support the guarantee.

Start with explicit labels or metadata rules to isolate integration feasibility from semantic classification. Prove both timing and control before building a broad rule editor or claiming automatic task-based switching across assistants.

If existing clients do not expose a submission barrier, decide whether an optional Modelog-assisted submission path is acceptable. Launching or managing sessions would be a broader product choice, not an assumed consequence of this proposal.

## Decisions for review

1. **Task boundary within a session:** should initial routing apply to each user request or named stages within a request?
2. **Detection:** how far can explicit labels and metadata go, and is an opt-in local semantic classifier desirable?
3. **Policy authoring:** should users start with a visual rule editor, a configuration file, or both? How should scope and conflicting rules be presented?
4. **Failure behavior:** when a switch cannot be confirmed, should the configured default pause submission, request manual selection, or continue with the current model while clearly reporting it?
5. **Integration scope:** is an optional submission or launch integration acceptable where native clients offer no interception point?
6. **Initial host:** should the first implementation follow the most feasible control surface, or the assistant most important to Modelog users?
7. **Primary mechanism:** is sub-agent delegation the primary mechanism, with session model swap as a later, host-limited option?
8. **Writing host configuration:** is it acceptable for Modelog to write agent definitions and instruction-file rules, given the consent, preview and removal requirements?
9. **Enforcement level:** is a probabilistic delegation guarantee acceptable, or is host-enforced routing required before the feature is offered?
10. **Sidechain treatment in analytics:** how should delegated turns enter per-model comparisons (PRD question 23), since this feature makes that decision unavoidable?

These decisions refine the implementation. The central goal is to make developer-defined behavior changes repeatable and measurable. Delegating side work to cheaper sub-agents is the most practical first route to that goal; task-based model switching within the same session remains an option where a host supports it.
