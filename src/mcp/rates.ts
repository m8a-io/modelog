import pricingJson from "../../data/pricing.json" with { type: "json" };
import { buildRateTable, type PricingFile, type RateTable } from "../metrics/cost.ts";

/**
 * The rate table the MCP server prices with, compiled into the bundle.
 *
 * The server runs as its own process, spawned by a client that may start it
 * with VS Code closed. It cannot ask VS Code anything, and it must not
 * hardcode a path into the extension's install directory, which is
 * version-stamped and dies at the next update (MCP.md §7.1). So the rate table
 * arrives the only other way it can: inlined at build time.
 *
 * This settles MCP.md §11 Q2, whose leaning was a copy written next to the
 * database. Rejected: Phase 3 already rewrites `mcp-server.mjs` into
 * globalStorage on a content-hash change, so a price change reaches the user
 * by the same route either way — while a second copy on disk could disagree
 * with the one the dashboard reads, which is the exact drift risk §5 cites as
 * the reason the server imports the metrics modules rather than restating
 * them. One source file, one release, no runtime path to get wrong.
 */

// `as unknown as` because the file carries `$comment` annotation keys that
// `PricingFile` deliberately does not model. `buildRateTable` already skips
// non-numeric modifier entries at runtime, so this is a typing gap, not a
// correctness one. The extension reaches the same type through `JSON.parse`,
// which launders it to `any` and hides the same mismatch.
export const PRICING: PricingFile = pricingJson as unknown as PricingFile;

export const RATE_TABLE: RateTable = buildRateTable(PRICING);
