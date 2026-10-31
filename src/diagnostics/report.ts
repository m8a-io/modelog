/**
 * The bug-report payload Modelog offers to open as a GitHub issue draft.
 *
 * Everything here is an **allowlist**. A thrown error contributes only its
 * class name and its machine-readable `code` (`ENOENT`, `ERR_SQLITE_ERROR`),
 * never its message or stack: those routinely embed home directories, project
 * names and settings values, and a report the user has to scrub before
 * posting will mostly be posted unscrubbed. The full error stays in the local
 * Modelog output channel, where the user decides what to copy.
 *
 * No `vscode` import, so the privacy rules are testable headlessly.
 */

export const NEW_ISSUE_URL = "https://github.com/m8a-io/modelog/issues/new";

export interface FailureSummary {
  /** A label from Modelog's own code — a command title or a fixed phase name — never user data. */
  operation: string;
  errorName: string;
  errorCode: string | null;
}

export type ActivationStatus =
  | { state: "starting" }
  | { state: "ready" }
  | { state: "failed"; failure: FailureSummary };

export interface ReportEnvironment {
  modelogVersion: string;
  editorName: string;
  editorVersion: string;
  uiKind: "desktop" | "web";
  /** `vscode.env.remoteName` — the remote *type* (`wsl`, `ssh-remote`), not a host name. */
  remoteName: string | null;
  extensionKind: "ui" | "workspace";
  platform: string;
  arch: string;
  osRelease: string;
  nodeVersion: string;
  storage: "sqlite" | "file" | "not initialized";
  activation: ActivationStatus;
  copilotChatVersion: string | null;
}

export interface IssueReport {
  title: string;
  body: string;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Version strings, platform names and Modelog's own command titles all fit; a path or a sentence does not. */
const TOKEN = /^[A-Za-z0-9 ._+():'-]{1,80}$/;

/** Reduce any thrown value to the fields a public report may carry. */
export function summarizeFailure(operation: string, error: unknown): FailureSummary {
  let errorName = "NonErrorValue";
  if (error instanceof Error) errorName = NAME.test(error.name) ? error.name : "Error";

  const rawCode =
    error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;

  return {
    operation: safeToken(operation),
    errorName,
    errorCode: typeof rawCode === "string" && CODE.test(rawCode) ? rawCode : null,
  };
}

export function buildIssueReport(env: ReportEnvironment, failure?: FailureSummary): IssueReport {
  const title = failure
    ? `${failure.operation} failed (${failure.errorCode ?? failure.errorName})`
    : "Modelog problem report";

  const lines = [
    "## What happened",
    "",
    "<!-- What were you doing, and what did you expect? Please do not paste prompts, code, file paths or other private information. -->",
    "",
  ];

  if (failure) {
    lines.push(
      "## Failure",
      "",
      `- Operation: ${failure.operation}`,
      `- Error type: ${failure.errorName}`,
      `- Error code: ${failure.errorCode ?? "none"}`,
      "",
    );
  }

  lines.push(
    "## Environment",
    "",
    `- Modelog: ${safeToken(env.modelogVersion)}`,
    `- Editor: ${safeToken(env.editorName)} ${safeToken(env.editorVersion)} (${env.uiKind})`,
    `- Extension host: ${env.remoteName === null ? "local" : `remote (${safeToken(env.remoteName)})`}, ${env.extensionKind} extension`,
    `- OS: ${safeToken(env.platform)} ${safeToken(env.osRelease)} (${safeToken(env.arch)})`,
    `- Extension host Node: ${safeToken(env.nodeVersion)}`,
    `- Storage: ${env.storage}`,
    `- Activation: ${activationText(env.activation)}`,
    `- Copilot Chat: ${env.copilotChatVersion === null ? "not installed" : safeToken(env.copilotChatVersion)}`,
    "",
    "<sub>Prepared by Modelog. It contains only the fields above — no error messages, stack traces, paths or session data. " +
      "The full error is in the Modelog output channel on your machine; review anything from it before adding it here.</sub>",
  );

  return { title, body: lines.join("\n") };
}

/** A pre-filled draft on GitHub's new-issue form. Nothing is posted until the user submits it there. */
export function issueUrl(report: IssueReport): string {
  const query = [
    `title=${encodeURIComponent(report.title)}`,
    `body=${encodeURIComponent(report.body)}`,
    "labels=bug",
  ].join("&");
  return `${NEW_ISSUE_URL}?${query}`;
}

function activationText(a: ActivationStatus): string {
  if (a.state !== "failed") return a.state;
  const { operation, errorName, errorCode } = a.failure;
  return `failed (${operation}: ${errorName}${errorCode ? `, ${errorCode}` : ""})`;
}

function safeToken(s: string): string {
  return TOKEN.test(s) ? s : "unknown";
}
