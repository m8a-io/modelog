import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBilling, billingCopy } from "../src/ingest/billing.ts";

function configFile(oauthAccount: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "modelog-billing-"));
  const path = join(dir, ".claude.json");
  writeFileSync(path, JSON.stringify({ oauthAccount }));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("prepaid detects as api billing", () => {
  const f = configFile({ billingType: "prepaid" });
  try {
    assert.deepEqual(detectBilling(f.path), { mode: "api", detected: true, rawType: "prepaid" });
  } finally {
    f.cleanup();
  }
});

test("a subscription with extra usage enabled is its own mode", () => {
  // The real shape observed on an account that crossed into usage credits
  // (issue #12): subscription billing plus the spill-over flag.
  const f = configFile({ billingType: "stripe_subscription", hasExtraUsageEnabled: true });
  try {
    const info = detectBilling(f.path);
    assert.equal(info.mode, "subscription-extra");
    assert.equal(info.detected, true);
    assert.equal(info.rawType, "stripe_subscription");
    // The copy must say the split is unknowable, not pretend to measure it.
    assert.match(billingCopy(info).detail, /not recorded/);
    assert.match(billingCopy(info).detail, /not a bill/);
  } finally {
    f.cleanup();
  }
});

test("a subscription without the flag stays plain subscription", () => {
  const f = configFile({ billingType: "stripe_subscription" });
  try {
    assert.equal(detectBilling(f.path).mode, "subscription");
  } finally {
    f.cleanup();
  }
});

test("prepaid wins over the extra-usage flag — per-token billing is already real", () => {
  const f = configFile({ billingType: "prepaid", hasExtraUsageEnabled: true });
  try {
    assert.equal(detectBilling(f.path).mode, "api");
  } finally {
    f.cleanup();
  }
});

test("a missing config detects nothing and defaults to the conservative mode", () => {
  const info = detectBilling("/nonexistent/.claude.json");
  assert.deepEqual(info, { mode: "subscription", detected: false, rawType: null });
});

test("the three modes produce three distinct labels", () => {
  const labels = new Set(
    (["api", "subscription", "subscription-extra"] as const).map(
      (mode) => billingCopy({ mode, detected: true, rawType: null }).label,
    ),
  );
  assert.equal(labels.size, 3);
});
