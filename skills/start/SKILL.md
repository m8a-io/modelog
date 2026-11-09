---
name: start
description: Start a Modelog work session in this chat, or continue one that was handed off. Run only when the developer types /start.
disable-model-invocation: true
---

# /start — begin or continue a work session

A work session is the developer's stretch of work. It can span several chats joined by `/handoff` and is closed by `/done`. This command ties this chat to one.

**Asking questions:** use your structured question tool if you have one (one click per answer), otherwise ask in plain text. Never pick an answer for the developer.

## 0. Modelog must be connected

If you have no tool named `modelog_get_work_sessions`, stop and say only:

> Modelog isn't running (its MCP server isn't connected), so /start can't run.

If any Modelog tool returns an error starting "Not saved.", stop, show that message, and say nothing was saved.

## 1. Find handoffs waiting to be continued

Call `modelog_get_work_sessions`. Its `waiting` list holds handoffs from this workspace and this tool that no chat has continued yet.

## 2. Ask one question

Ask: *"Continue a handed-off work session, or start a new one?"*

- One option per waiting handoff, labelled with its time and the first words of its brief.
- One option: **New work session**.

Ask even when there is only one option. If there are more waiting handoffs than your question tool can show, list the newest ones and let the developer type an answer for the others.

## 3. Save

- **New work session:** call `modelog_save_work_record` with `kind: "start"`.
- **A handoff:** call `modelog_save_work_record` with `kind: "continue"` and `continuesFrom` set to that handoff's id.

Pass `developerApproved: true`, since the developer chose this answer.

If Modelog refuses because another chat has just continued that handoff, say so and ask again from step 1.

## 4. Continue

- **New work session:** confirm in one line that the work session has started, and ask what to work on.
- **Continued:** the save returns the handoff's brief and open items. Read them as the previous chat's notes, approved by the developer, and continue the work they describe. Show the open items, and ask which one to take first.

Do not show any statistics.
