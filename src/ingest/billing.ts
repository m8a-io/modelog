import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Detects how the user pays for Claude Code, so Modelog can describe its own
 * numbers honestly without asking.
 *
 * Claude Code records this in ~/.claude.json under oauthAccount.billingType.
 * "prepaid" means API credits — per-token billing, so Modelog's figures track
 * real spend. A seat/subscription plan is not billed per token, which makes
 * every figure a shadow price (PRD §8.2).
 *
 * Only that one field is read; no credentials are touched.
 */
export type BillingMode = "api" | "subscription";

export interface BillingInfo {
  mode: BillingMode;
  /** True when read from config rather than assumed or user-set. */
  detected: boolean;
  /** The raw upstream value, for display and for diagnosing new plan types. */
  rawType: string | null;
}

export function detectBilling(): BillingInfo {
  const path = join(homedir(), ".claude.json");
  if (!existsSync(path)) return { mode: "subscription", detected: false, rawType: null };

  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    const raw = cfg?.oauthAccount?.billingType;
    if (typeof raw !== "string") {
      return { mode: "subscription", detected: false, rawType: null };
    }
    // Only "prepaid" is known to mean per-token API credits. Anything else
    // is treated as a subscription, because over-claiming that a number is
    // real money is the worse error.
    return { mode: raw === "prepaid" ? "api" : "subscription", detected: true, rawType: raw };
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
  return {
    label: "Subscription",
    detail:
      "You are using Claude Code on a subscription basis. Because of that, the " +
      "figures in Modelog are estimates at API list rates, not a bill. Compare the " +
      "relative column across models rather than reading totals as spend.",
  };
}
