---
name: done
description: Close the current Modelog work session — the work done and open items, then save. Run only when the developer types /done.
disable-model-invocation: true
---

# /done — close the work session

A work session can span several chats joined by `/handoff`. `/done` closes **all** of it. You draft what was done and what is still open, the developer approves, and Modelog saves the closure.

**Asking questions:** use your structured question tool if you have one (one click per answer), otherwise ask in plain text. Never pick an answer for the developer.

## 0. Modelog must be connected

If you have no tool named `modelog_save_work_record`, stop and say only:

> Modelog isn't running (its MCP server isn't connected), so /done can't run.

If any Modelog tool returns an error starting "Not saved.", stop, show that message, and say nothing was saved.

## 1. Which work session

Call `modelog_get_work_sessions`. If `current` is empty but `waiting` lists handoffs, ask whether this chat continues one of them (labelled by time and the brief's first words), or **None of these**. If the developer picks one, remember its id as `continuesFrom`.

If this chat continues earlier chats, `current` includes their briefs and open items. Use them for step 2, since you have not seen those chats yourself.

## 2. Draft

- **Work done**, at most 600 characters, covering the whole work session: what was accomplished **and what failed**.
- **Open items**, at most 10 of up to 200 characters each: anything raised and not resolved, including earlier open items that are still open. Raising these is a primary job of `/done`: a developer often feels done before the work is.

## 3. Approve

Show both drafts in full. Then ask: **Save** · **Edit** · **Abort**.

- **Edit:** take the developer's changes, show the result, and ask again.
- **Abort**, for example *"I missed those, let's do them"*: stop. Nothing is saved. Say so, then help with the open items.

## 4. Save

Call `modelog_save_work_record` with `kind: "done"`, `summary`, `openItems`, `continuesFrom` if you found one in step 1, and `developerApproved: true`. For `provenance`, give `"generated"` for a field the developer accepted as you drafted it, and `"user"` for one they wrote or rewrote.

## 5. After saving

Report what the save returned: that the work session is closed, and how many handoffs it had. Show no other numbers.
