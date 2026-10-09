# Modelog Model Switcher

**Status:** Proposal for review; no implementation commitment.

**Research date:** 2026-10-09.

Modelog should be able to recognize an upcoming task and automatically select the user's preferred model **before that task starts**. The reasons for switching must be entirely user-defined: the user decides what constitutes a task, which signals matter, which conditions cause a switch, and which model should handle the work.

Modelog is currently an analytics tool. This feature would add an optional control capability alongside its analytics. It does not require Modelog to become an agent. The intended experience is to keep working in Claude Code, Copilot, or Codex while Modelog applies the user's model-selection policy where the host supports it.

## Motivation: make behavior changes repeatable and measurable

Modelog grew from wanting to understand the effects of changing one's own development behavior. One example is deliberately switching models more often to match different tasks, primarily within the same session and also across sessions. The question is whether that change in working habits makes a useful difference.

The model switcher gives developers a clear method for putting such a change into practice. A developer can express an intended behavior as rules, have Modelog apply those rules consistently, and use Modelog's analytics to examine what happened. Automation reduces the need to remember each manual switch while preserving the developer's control over the behavior being tried.

The intended cycle is: observe current behavior, define a change, apply it, review the resulting behavior and measurements, and refine or revert the rules. More frequent switching is one possible experiment, not a success metric in itself. Users may ultimately choose fewer switches or different task-to-model mappings.

For example, a developer who normally uses one model throughout a session could define separate selections for planning, implementation, and review. As those tasks begin in the same conversation, Modelog would apply the selections and record which changes actually occurred. The developer could then compare that pattern with their previous practice, subject to the limits of the available measurements.

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

A single request can contain several activities, such as planning, implementation, and testing. Switching between those activities requires the host to expose additional boundaries. Internal tool calls, follow-up turns, and subagents should not automatically be treated as new routing opportunities without an explicit policy and corresponding host support.

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

Model changes may affect cache reuse and subsequent request cost. Claude's [model configuration documentation](https://code.claude.com/docs/en/model-config) describes model-specific prompt caching and the cost of rereading context after a switch. Users may therefore want switching-frequency rules; Modelog should not assume that more switching means lower cost.

Comparisons must preserve existing [PRD constraints](PRD.md): explicit monetary units, no cross-vendor cost comparison, unknown prices shown as unavailable, and subscription shadow prices distinguished from bills. Before/after analytics are observational; they do not prove that a routing policy improved quality or caused savings.

The [MCP bridge](MCP.md) is currently read-only. Switching requires a separate control adapter and does not arise simply from exposing analytics over MCP. This proposal does not change the existing MCP contract. Codex also needs appropriate usage observation if its routing outcomes are to appear alongside the currently supported Claude Code and Copilot analytics.

## Feasibility validation and proposed first scope

The first investigation should target Codex app-server because it has the strongest evidence for changing an existing thread's model. This is a technical prototype recommendation, not a decision to prioritize Codex commercially.

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

These decisions refine the implementation. The central goal is to make developer-defined behavior changes repeatable and measurable, primarily through task-based model switching within the same session.
