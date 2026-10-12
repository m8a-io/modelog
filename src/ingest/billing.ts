import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Detects how the user pays for Claude Code, so Modelog can describe its own
 * numbers honestly without asking.
 *
 * Claude Code records this in ~/.claude.json under oauthAccount. Two fields
 * are read; no credentials are touched:
 *
 * - `billingType` — "prepaid" means API credits: per-token billing, so
 *   Modelog's figures track real spend. A seat/subscription plan is not
 *   billed per token, which makes every figure a shadow price (PRD §8.2).
 *   The value set is wider and less stable than it looks: switching the
 *   payment method on an account has been observed to flip it (issue #12),
 *   so nothing beyond the one known value is interpreted.
 * - `hasExtraUsageEnabled` — a subscription that can spill into per-token
 *   "usage credits" once the plan allowance runs out. Which turns drew from
 *   that pool is recorded nowhere on disk, so the mode changes what Modelog
 *   SAYS about its figures, never how they are computed.
 */
export type BillingMode = "api" | "subscription" | "subscription-extra";

export interface BillingInfo {
  mode: BillingMode;
  /** True when read from config rather than assumed or user-set. */
  detected: boolean;
  /** The raw upstream value, for display and for diagnosing new plan types. */
  rawType: string | null;
}

export function detectBilling(
  path: string = join(homedir(), ".claude.json"),
): BillingInfo {
  if (!existsSync(path)) return { mode: "subscription", detected: false, rawType: null };

  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    const account = cfg?.oauthAccount;
    const raw = account?.billingType;
    if (typeof raw !== "string") {
      return { mode: "subscription", detected: false, rawType: null };
    }
    // Only "prepaid" is known to mean per-token API credits. Anything else
    // is a subscription, because over-claiming that a number is real money
    // is the worse error — refined to "subscription-extra" when the account
    // can spill into usage credits, which changes what the figures may mean
    // without making any of them a measurement.
    const mode: BillingMode =
      raw === "prepaid"
        ? "api"
        : account?.hasExtraUsageEnabled === true
          ? "subscription-extra"
          : "subscription";
    return { mode, detected: true, rawType: raw };
  } catch {
    return { mode: "subscription", detected: false, rawType: null };
  }
}

export function billingCopy(info: BillingInfo): { label: string; detail: string } {
  if (info.mode === "api") {
    return {
      label: "API credits",
      detail:
        "You are paying for Claude Code with prepaid API credits, billed per token. " +
        "Modelog computes these figures from published list rates, so they should " +
        "track your actual spend closely — but Modelog cannot see your invoice, so " +
        "treat them as a very good estimate rather than a statement of account.",
    };
  }
  if (info.mode === "subscription-extra") {
    return {
      label: "Subscription + usage credits",
      detail:
        "You are on a subscription with extra usage enabled: once the plan " +
        "allowance runs out, further usage is billed from usage credits per " +
        "token. Which turns drew from that pool is not recorded in the logs " +
        "Modelog reads, so it cannot split estimated from actually-billed " +
        "usage — every figure remains an estimate at API list rates, and the " +
        "totals are not a bill.",
    };
  }
  return {
    label: "Subscription",
    detail:
      "You are using Claude Code on a subscription basis. Because of that, the " +
      "figures in Modelog are estimates at API list rates, not a bill. Compare the " +
      "relative column across models rather than reading totals as spend.",
  };
}

/**
 * How to describe Copilot's figures.
 *
 * Deliberately says nothing about which plan the user is on or whether a
 * credit came out of an allowance. Detecting that needs auth state or a
 * network call, and §8.1 permits neither — so rather than guess at a plan,
 * this states exactly what is known and names what is not. The statement is
 * true on every Copilot plan, which is why it is the right thing to say.
 */
export function copilotBillingCopy(): { label: string; detail: string } {
  return {
    label: "Copilot credits",
    detail:
      "Copilot figures are credits consumed, as measured and reported by Copilot " +
      "itself against the rate card in force for each session — not an estimate " +
      "Modelog computed. Whether those credits came out of a monthly allowance or " +
      "were billed as overage is not visible to Modelog, so a credit total is not a " +
      "bill. Credits are never converted to dollars, and Copilot and Claude Code " +
      "figures are never added together or compared.",
  };
}

/**
 * How to describe Codex's figures.
 *
 * Codex reports no cost in its own logs, so every figure is derived from
 * token counts against Modelog's own rate card, the same as Claude Code.
 * Unlike Claude Code, there is no billing-mode file Modelog is willing to
 * read: `~/.codex/auth.json` holds OAuth credentials, not configuration, so
 * it is deliberately never opened. That means Modelog cannot tell a ChatGPT
 * subscription (not metered per token) apart from API-key billing here —
 * stating that plainly is the honest option, not a guess at a default.
 */
export function codexBillingCopy(): { label: string; detail: string } {
  return {
    label: "Codex (shadow price)",
    detail:
      "Codex figures are estimates at published API list rates, derived from " +
      "token counts the same way Claude Code's are. Modelog cannot detect whether " +
      "you pay for Codex through a ChatGPT subscription or metered API credits — " +
      "doing so would mean reading Codex's credential file, which Modelog will not " +
      "do — so treat these figures as a relative comparison across models, not a bill.",
  };
}
