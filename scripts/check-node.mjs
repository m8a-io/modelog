// Tests are plain .ts run by `node --test`, which relies on Node's type
// stripping. Node 20 has none, and its failure message says nothing useful.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`
  Modelog needs Node 24+ to run its tests (found v${process.versions.node}).

  Tests are plain TypeScript executed by \`node --test\`, which requires
  Node's type stripping. Node 20 reached end-of-life on 2026-04-30.

      nvm alias default 24 && nvm use 24
  `);
  process.exit(1);
}
