---
name: handoff
description: Hand this Modelog work session over to a fresh chat, saving a brief and open items so /start in the new chat can continue. Run only when the developer types /handoff.
disable-model-invocation: true
---

# /handoff — end this chat, keep the work session going

A handoff ends this **chat**, not the work session, so there is **no rating**. You write a brief the next chat will continue from; the developer approves it; Modelog stores it. The developer then opens a new chat and runs `/start`.

**Asking questions:** use your structured question tool if you have one (one click per answer), otherwise ask in plain text. Never pick an answer for the developer.

## 0. Modelog must be connected

If you have no tool named `modelog_save_work_record`, stop and say only:

> Modelog isn't running (its MCP server isn't connected), so /handoff can't run.

If any Modelog tool returns an error starting "Not saved.", stop, show that message, and say nothing was saved.

## 1. Is this chat already part of a work session?

Call `modelog_get_work_sessions`. If `current` is empty but `waiting` lists handoffs, ask whether this chat continues one of them (labelled by time and the brief's first words), or **None of these**. If the developer picks one, remember its id as `continuesFrom` for step 4.

## 2. Draft

- **Brief**, at most 1,500 characters. It is written for the next agent, which has seen none of this chat. Cover the current state of the work, decisions made and why, what to do next, and the files that matter. Include no secrets or credentials.
- **Open items**, at most 10 of up to 200 characters each: anything raised in this chat and not resolved. Raising these is a primary job of this command: a developer often feels done before the work is.

## 3. Approve

Show both drafts in full. Then ask: **Save** · **Edit** · **Abort**.

- **Edit:** take the developer's changes, show the result, and ask again.
- **Abort:** stop, and say nothing was saved.

## 4. Save

Call `modelog_save_work_record` with `kind: "handoff"`, `brief`, `openItems`, `continuesFrom` if you found one in step 1, and `developerApproved: true`. For `provenance`, give `"generated"` for a field the developer accepted as you drafted it, and `"user"` for one they wrote or rewrote.

## 5. Finish

On success, do **not** print the brief again; the developer has just approved it. Say in one line that the handoff is saved, and that they can open a new chat and run `/start` to continue.

Do not show any statistics.
