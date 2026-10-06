// Pure checks of the outside-coin devnet run's record, shared by the run and its regression test.

/** The partner-fee checkpoints a finished run must carry: checkpoint 1 recorded equal (the deposits,
 *  launch, tail migration and first harvests left the other partner's fee untouched), and the LATEST
 *  checkpoint 2 (taken after the last source trade of the current attempt; a resumed attempt that
 *  repeats the source trading records a newer one, which supersedes the earlier). */
export function partnerFeeCheckpoints(steps: { name: string; [k: string]: any }[]) {
  const cp1 = steps.find((x) => x.name === "partner fee checkpoint 1 after");
  if (!cp1 || cp1.equal !== true) throw new Error("partner fee checkpoint 1 missing or not recorded equal");
  const all2 = steps.filter((x) => x.name === "partner fee checkpoint 2 before");
  if (all2.length === 0) throw new Error("partner fee checkpoint 2 missing");
  const cp2 = all2[all2.length - 1];
  return { cp1, cp2: { poolA: cp2.poolA, poolB: cp2.poolB, A: cp2.A, B: cp2.B, feeClaimer: cp2.feeClaimer, leftoverReceiver: cp2.leftoverReceiver } };
}
