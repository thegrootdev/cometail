// COMETAIL worker: one process, two loops. The keeper harvests, migrates, registers,
// routes bids and settles fills for every vault; the indexer follows program events.
// Both land in build steps 8-9. For now this only proves the package wires up.
export const WORKER_VERSION = "0.1.0";

async function main() {
  console.log(`cometail worker ${WORKER_VERSION}: nothing to do yet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
