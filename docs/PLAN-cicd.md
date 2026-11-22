# PLAN-cicd — Modelog on m8a's CI/CD

Started 2026-11-22. Status: **planning; nothing built.** Move Modelog's CI and release from GitHub Actions plus hand steps to the m8a pipeline (ci-engine + Dagger), as m8a-go does.

## Decisions (Scott, 2026-11-22)

| Question | Decision |
| :--- | :--- |
| `.github/workflows/ci.yml` | **Replace** it with the ci-engine's "m8a CI" check run, once that is proven |
| Marketplace publish | **Server publishes** — a Marketplace target in the ci-engine, PAT held in OpenBao/ESO, not on Scott's machine |
| Shared release logic | **Self-contained** module in this repo. No dependency on m8a-go, which is private (modelog is public) |
| Dagger SDK | **TypeScript** |
| Where the work happens | An **m8a RDE** in Coder. This WSL machine has no `dagger`, `m8a`, `docker` or `coder`, so nothing here can be built or verified locally |

## What the m8a pattern is (read 2026-11-22)

Sources: `m8a-go/.m8a/README.md`, `m8a-docs` PLT-030 (release plans), PLT-034 (release units and promotion), `platform/services/ci-engine/proxy-mode.md`.

- The repo carries a Dagger module (`dagger.json` in the root, source in `.m8a/ci-cd/`). Verbs: `pre-ci-run`, `lint`, `test`, `build`, `analyze`, `post-ci-run`, plus `run-plan` (does this event run?), `release-plan` (what does it release?) and `publish` (what is each artifact made of?).
- **Server loop:** a push reaches the ci-engine through the `m8a-ci` GitHub App webhook. It posts a check run, clones the commit, runs the verbs, then approves and delivers the release plan.
- **Local loop:** in an RDE, `m8a ci pipeline` and `m8a ci plan` go through the sidecar proxy to the cluster Dagger engine. They run on uncommitted files and **never release**.
- **Approve step:** an artifact whose inputs changed but whose version is already released fails the run before any build. Targets are named **grants** on the repository record, set by devOps (`ci-engine register-repo … --target`), never in the repo.
- **Artifact kinds today:** `image`, `binary`, `npm`. PLT-030 says a module may be Go, TypeScript or Python.
- Reusable references: `m8a-go/.m8a/ci-cd/{verify,run,release}.go` (verbs, skip rule, plan), and `rde-catalog/templates/m8a-node` plus `images/node-dev` for a Node RDE.

## Gaps this plan has to close

1. **No Marketplace target exists.** `vsce publish` is not an artifact kind. "Server publishes" therefore needs: a new kind and target kind (for example `vsix` → `vsce-marketplace`), a deliverer, a credential path for the PAT, and a devOps grant. That is a change to the ci-engine and to PLT-030, so per m8a-docs' rule it needs a matching decision update there. It is a separate workstream in m8a-go, not something this repo can do alone.
2. **Self-contained vs. the `release` module.** The plan/approve/deliver machinery lives in m8a-go's `modules/release`. A self-contained module has to emit the plan JSON of PLT-030 §3.4 and do its own delivery. Check whether the engine's approve step accepts that, or needs the module's types.
3. **No TypeScript module is proven against the engine.** PLT-030 §4.2 sketches one (m8a, Rush); m8a-go and foundation-images are Go. Verify the verb contract end to end before relying on it.
4. **Public repo, private cluster.** Replacing `ci.yml` means public PRs depend on m8a's cluster being up. Revisit when that is first felt.

## Phases

**Phase 0 — Environment.** Scott creates a Coder RDE for modelog from `m8a-node` (Node 24 needed, per CLAUDE.md). Confirm `m8a ci list` and `dagger version` work there. Clone `m8a-docs` and `m8a-go` as siblings.

**Phase 1 — Verify only.** `dagger init --sdk=typescript` with source `.m8a/ci-cd`. Verbs `lint`, `test`, `build`, `analyze` wrap what `npm run check` already does (typecheck, `scripts/check-theme.sh`, `node --test test/*.test.ts`) and `npm run package` for the build. Docs-only changes finish at once, as in m8a-go. Prove with `m8a ci pipeline`.

**Phase 2 — Server verify.** devOps registers the repo and installs the GitHub App on `m8a-io/modelog`. Pushes get an "m8a CI" check run. Run it beside `ci.yml` until it is trusted, then delete `ci.yml` (decision above).

**Phase 3 — Release to GitHub.** `release-plan` on merges into `main`. The version comes from `package.json`. The `.vsix` ships as a `binary` artifact to a `github-release` grant on `m8a-io/modelog`, tagged from the version. This replaces my hand steps: tag, GH Release from the CHANGELOG section, and the dev fast-forward stays manual or is scripted separately. The build comes from a clean clone, which fixes the problem of untracked files ending up in the `.vsix`.

**Phase 4 — Marketplace.** After gap 1 is closed in m8a-go and PLT-030: add the Marketplace target and grant, and publish from the server.

**Phase 5 — Update m8a-docs.** Record Modelog as the first Node/VS Code repo on the loop, and the Marketplace target decision.

## Open questions

- **Approval:** Scott wants publishing to remain a deliberate step. Does "server publishes" mean automatic on merge to `main`, or behind a PLT-034 approval gate that Scott clicks? Not decided; Phase 4 should not start without an answer.
- Which branch is the release branch? m8a-go releases on `staging`. Modelog's flow is `dev` → PR → `main`, so `main` is the natural choice, but the ci-engine docs assume `staging`/`production`.
- Version bumps: m8a requires a bump when artifacts change. Modelog already bumps `package.json` and CHANGELOG per release, so this fits, but a plain feature merge into `main` without a bump would fail at approve. Is that wanted?
- Carried over from the handoff, untouched: the Disable MCP Server path from 0.10.0 is not tested live. 0.10.0 is not tested on a fresh IDE-only remote install. The remote branch `fix/39-user-scope-mcp` still exists. Check that issue #39 closed with PR #40.
