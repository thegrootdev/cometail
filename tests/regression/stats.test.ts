// The public proof figures (worker/src/stats.ts, /api/stats): launches are attributed by their owner (a vault-held
// launch by its depositor; without a vault only a wallet-held creator is an owner), volume is summed from the indexed
// trades only once every pool of the launch has a finished cursor and every trade has its quote leg, and a pool
// account that cannot be read leaves its fees unknown, never zero.
import { Keypair } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { openStore, type TokenRow, type TradeRow } from "../../worker/src/store";
import { statsViewer } from "../../worker/src/stats";
import { burnsIn, pairedBurnPass, readPairedBurns } from "../../worker/src/pairedburns";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

const WSOL = "So11111111111111111111111111111111111111112";
const key = () => Keypair.generate().publicKey.toBase58();
async function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-"));
  const store = openStore(`sqlite:${path.join(dir, "store.sqlite")}`); await store.init();
  return store;
}
function token(o: Partial<TokenRow>): TokenRow {
  return { mint: key(), decimals: 6, name: "x", symbol: "X", imageUrl: null, metadataUri: null, metadataStatus: "ok", creator: key(), custody: "wallet" as any, config: key(),
    tokenKind: "plain", dbcPool: key(), dammPool: null, quoteMint: WSOL, vault: null, stage: "bonding", priceQuote: null, priceSol: null, quoteDecimals: 9, priceSource: null,
    priceAtMs: 0, totalSupplyRaw: "1000000000000000", quoteRaisedLamports: "0", targetLamports: "0", progressBps: null, holders: null, holdersAtMs: null, liquidityLamports: null,
    liquidityBasis: null, links: null, volume24hLamports: "0", buys24h: 0, sells24h: 0, volumeComplete: true, createdAtMs: 0, updatedAt: 0, ...o };
}
let sig = 0;
function trade(pool: string, trader: string, quote: string | undefined, venue: "curve" | "damm" = "curve", o: Partial<TradeRow> = {}): TradeRow {
  sig++;
  return { signature: `sig${sig}`, idx: 0, slot: sig, blockTime: sig, pool, vault: "", trader, traderKind: "authority", buy: sig % 2 === 0, amountIn: "1", amountOut: "1", venue, baseAmountRaw: "1", quoteAmountLamports: quote, ...o };
}
// a chain whose pool accounts are all missing: the fee counters cannot be read
const blindChain = { connection: { getMultipleAccountsInfoAndContext: async (keys: unknown[]) => ({ context: { slot: 7 }, value: keys.map(() => null) }) }, damm: { programId: Keypair.generate().publicKey }, dbc: {} } as any;

describe("public proof figures", () => {
  it("attributes launches by owner, a vault-held launch by its depositor", async () => {
    const store = await freshStore();
    const me = key(), vault = key();
    const ours = token({ creator: me, stage: "graduated" });
    const held = token({ creator: vault, vault, custody: "program" as any, tokenKind: "stream" });
    const theirs = token({});
    const orphan = token({ creator: key(), vault: key(), custody: "program" as any }); // its vault is not indexed: owner unknown
    orphan.creator = orphan.vault!;
    const pda = token({ custody: "program" as any }); // a program-held creator with no vault: not a proven outside owner
    const unknown = token({ custody: "unknown" as any });
    await store.upsertTokens([ours, held, theirs, orphan, pda, unknown]);
    await store.upsertVault(vault, { depositor: me, status: { launched: {} }, accounting: { harvestedGross: "5" } });
    await store.setMeta("tokens_scanned_at", "1000");
    const v: any = await statsViewer(blindChain, store, { cluster: "test", team: [me], feeIndex: null, burnView: null, tailView: null })();
    expect(v.launches).to.include({ total: 6, team: 2, outside: 1, unattributed: 3 });
    expect(v.launches.graduated).to.deep.eq({ total: 1, team: 1, outside: 0 });
    expect(v.vaults).to.include({ total: 1, launched: 1 });
    // no pool account could be read: every fee figure is unknown
    expect(v.fees).to.include({ curveTradingLamports: null, totalLamports: null, meteoraProtocolLamports: null });
    expect(v.burn).to.eq(null);
  });

  it("sums volume and traders only while the index is complete and every trade has its quote leg", async () => {
    const store = await freshStore();
    const a = token({}), b = token({ dammPool: key(), stage: "graduated" });
    await store.upsertTokens([a, b]);
    const w1 = key(), w2 = key();
    await store.insertTrades([trade(a.dbcPool, w1, "100"), trade(a.dbcPool, w2, "50"), trade(b.dbcPool, w1, "7"), trade(b.dammPool!, w2, "3", "damm")]);
    await store.setMeta("tokens_scanned_at", "1000");
    const opts = { cluster: "test", team: [], feeIndex: null, burnView: null, tailView: null };
    const ok = { head: "h", tail: null, target: null, newHead: null, status: "ok" as const };

    // just discovered: the indexer has not reached these pools, so there is no cursor yet: nothing is proven
    let v: any = await statsViewer(blindChain, store, opts)();
    expect(v.trading).to.include({ complete: false, pendingPools: 3, volumeLamports: null, traders: null });
    expect(v.launches.list.every((l: any) => l.volumeLamports === null)).to.eq(true);

    // the curves are caught up, the graduated pool not yet: only that launch stays unknown
    await store.setPoolCursor(a.dbcPool, ok); await store.setPoolCursor(b.dbcPool, ok);
    v = await statsViewer(blindChain, store, opts)();
    expect(v.trading).to.include({ complete: false, pendingPools: 1, volumeLamports: null });
    expect(v.launches.list.find((l: any) => l.mint === a.mint).volumeLamports).to.eq("150");
    expect(v.launches.list.find((l: any) => l.mint === b.mint).volumeLamports).to.eq(null);

    await store.setPoolCursor(b.dammPool!, ok);
    v = await statsViewer(blindChain, store, opts)();
    expect(v.trading).to.include({ complete: true, trades: 4, traders: 2, volumeLamports: "160" });
    expect(v.launches.list.find((l: any) => l.mint === b.mint).volumeByVenue).to.deep.eq({ curve: "7", damm: "3" });

    // a trade without its quote leg makes that launch's volume, and the total, unknown
    await store.insertTrades([trade(a.dbcPool, w1, undefined)]);
    v = await statsViewer(blindChain, store, opts)();
    expect(v.launches.list.find((l: any) => l.mint === a.mint).volumeLamports).to.eq(null);
    expect(v.trading.volumeLamports).to.eq(null);

    // a pool still catching up: no volume and no trader count at all
    await store.setPoolCursor(a.dbcPool, { ...ok, status: "pending" });
    v = await statsViewer(blindChain, store, opts)();
    expect(v.trading).to.include({ complete: false, pendingPools: 1, volumeLamports: null, traders: null });
  });

  it("values a paired launch's trades in SOL at their own $COMETAIL price and counts the routed legs", async () => {
    const store = await freshStore();
    const cometailMint = key(), cometailPool = key(), w1 = key();
    const cometail = token({ mint: cometailMint, stage: "graduated", dammPool: cometailPool });
    const coin = token({ quoteMint: cometailMint, quoteDecimals: 6 });
    const other = token({ quoteMint: key(), quoteDecimals: 6 }); // an unknown quote: never in SOL
    await store.upsertTokens([cometail, coin, other]);
    // $COMETAIL's pool: 1 SOL for 10,000,000 $COMETAIL (raw 10^13), at slot 100
    const p1 = trade(cometailPool, w1, "1000000000", "damm", { slot: 100, baseAmountRaw: "10000000000000" });
    // a site buy at slot 200: SOL -> $COMETAIL at 2 SOL for 10M, then that $COMETAIL into the coin, same signature
    const legA = trade(cometailPool, w1, "2000000000", "damm", { slot: 200, idx: 0, baseAmountRaw: "10000000000000", signature: "route1" });
    const legB = trade(coin.dbcPool, w1, "10000000000000", "curve", { slot: 200, idx: 1, signature: "route1" });
    // a direct $COMETAIL trade at slot 300: valued at the pool's last trade at or before it (slot 200: 2 SOL per 10M)
    const direct = trade(coin.dbcPool, w1, "5000000000000", "curve", { slot: 300 });
    await store.insertTrades([p1, legA, legB, direct, trade(other.dbcPool, w1, "777")]);
    for (const p of [cometail.dbcPool, cometailPool, coin.dbcPool, other.dbcPool]) await store.setPoolCursor(p, { head: "h", tail: null, target: null, newHead: null, status: "ok" });
    await store.setMeta("tokens_scanned_at", "1000");
    const burnView = async () => ({ status: "live", setup: { cometailMint, pool: cometailPool }, totals: {}, cometail: null, history: null });
    const v: any = await statsViewer(blindChain, store, { cluster: "test", team: [], feeIndex: null, burnView, tailView: null })();
    const l = v.launches.list.find((x: any) => x.mint === coin.mint);
    expect(l).to.include({ paired: true, volumeLamports: "15000000000000", volumeSolLamports: "3000000000" });
    expect(v.launches.list.find((x: any) => x.mint === other.mint).volumeSolLamports).eq(null);
    // SOL total: $COMETAIL's own pool (1 + 2 SOL) plus the paired coin (3 SOL); the unknown quote is left out
    expect(v.trading).to.include({ volumeLamports: "6000000000", pairedVolumeLamports: "3000000000", pairedRoutedLamports: "2000000000" });
    expect(v.pairedQuote).to.include({ mint: cometailMint, pool: cometailPool, launches: 1 });

    // a paired trade before $COMETAIL's pool has any trade cannot be priced: unknown, not zero
    await store.insertTrades([trade(coin.dbcPool, w1, "1", "curve", { slot: 50 })]);
    const v2: any = await statsViewer(blindChain, store, { cluster: "test", team: [], feeIndex: null, burnView, tailView: null })();
    expect(v2.launches.list.find((x: any) => x.mint === coin.mint).volumeSolLamports).eq(null);
    expect(v2.trading.volumeLamports).eq(null);
    // $COMETAIL's pool still catching up: the paired launch is unproven in SOL
    await store.setPoolCursor(cometailPool, { head: "h", tail: null, target: null, newHead: null, status: "pending" });
    const v3: any = await statsViewer(blindChain, store, { cluster: "test", team: [], feeIndex: null, burnView, tailView: null })();
    expect(v3.trading.pairedVolumeLamports).eq(null);
  });

  it("a burn counts only with its whole provenance: the claimer's own claim, its actual payout as the only inflow, exactly half burned and the rest to its account (F6)", async () => {
    const store = await freshStore();
    const mint = Keypair.generate().publicKey, claimer = Keypair.generate().publicKey, config = Keypair.generate().publicKey;
    const account = getAssociatedTokenAddressSync(mint, claimer);
    const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"), DAMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
    const CLAIM_FEE = Buffer.from([8, 236, 89, 49, 152, 125, 177, 81]), SURPLUS = Buffer.from([168, 173, 72, 100, 201, 98, 38, 92]), SWAP2 = Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]), POSITION_FEE = Buffer.from([180, 38, 154, 17, 133, 33, 162, 211]);
    const amountData = (op: number, n: bigint) => { const b = Buffer.alloc(10); b[0] = op; b.writeBigUInt64LE(n, 1); b[9] = 6; return b; };
    const filler = () => Keypair.generate().publicKey;
    type Ix = { program: PublicKey; accounts: PublicKey[]; data: Buffer; inner?: Ix[] };
    // Meteora's IDL account orders: [dest, vault, mint, signer, config] indexes per claim
    const LAYOUT = { fee: { program: DBC, disc: CLAIM_FEE, dest: 4, vault: 6, mint: 8, signer: 9, config: 1, n: 14 }, surplus: { program: DBC, disc: SURPLUS, dest: 3, vault: 4, mint: 5, signer: 6, config: 1, n: 10 }, position: { program: DAMM, disc: POSITION_FEE, dest: 4, vault: 6, mint: 8, signer: 10, config: -1, n: 15 } };
    const vault = filler();
    /** a claim paying `paid` from its vault into `dest` (an inner transfer), signed by `by`, quote mint `m`, under `cfg` */
    const claim = (kind: keyof typeof LAYOUT, dest: PublicKey, paid: bigint, o: { by?: PublicKey; m?: PublicKey; cfg?: PublicKey; disc?: Buffer } = {}): Ix => {
      const L = LAYOUT[kind];
      const accounts = Array.from({ length: L.n }, (_, i) => i === L.dest ? dest : i === L.vault ? vault : i === L.mint ? (o.m ?? mint) : i === L.signer ? (o.by ?? claimer) : i === L.config ? (o.cfg ?? config) : filler());
      return { program: L.program, accounts, data: Buffer.concat([o.disc ?? L.disc, Buffer.alloc(16)]), inner: paid > 0n ? [transfer(vault, dest, paid, filler())] : [] };
    };
    const transfer = (from: PublicKey, to: PublicKey, n: bigint, auth = claimer): Ix => ({ program: TOKEN_PROGRAM_ID, accounts: [from, mint, to, auth], data: amountData(12, n) });
    const burn = (src: PublicKey, n: bigint): Ix => ({ program: TOKEN_PROGRAM_ID, accounts: [src, mint, claimer], data: amountData(15, n) });
    const mintTo = (to: PublicKey, n: bigint): Ix => ({ program: TOKEN_PROGRAM_ID, accounts: [mint, to, filler()], data: amountData(14, n) });
    const wrap = (inner: Ix): Ix => ({ program: filler(), accounts: [], data: Buffer.alloc(8), inner: [inner, ...(inner.inner ?? [])] });
    /** signers: the fee payer and `signers` (the claimer by default) */
    const tx = (ixs: Ix[], o: { held?: { account: PublicKey; amount: string }[]; signers?: PublicKey[] } = {}) => {
      const keys: PublicKey[] = [];
      const at = (k: PublicKey) => { let i = keys.findIndex((x) => x.equals(k)); if (i < 0) { keys.push(k); i = keys.length - 1; } return i; };
      const signers = o.signers ?? [claimer];
      for (const k of signers) at(k);
      const compiled = ixs.map((ix) => ({ programIdIndex: at(ix.program), accountKeyIndexes: ix.accounts.map(at), data: Uint8Array.from(ix.data) }));
      const innerInstructions = ixs.map((ix, index) => ({ index, instructions: (ix.inner ?? []).map((n) => ({ programIdIndex: at(n.program), accounts: n.accounts.map(at), data: utils.bytes.bs58.encode(n.data) })) })).filter((g) => g.instructions.length);
      const pre = (o.held ?? []).map((h) => ({ accountIndex: at(h.account), mint: mint.toBase58(), uiTokenAmount: { amount: h.amount } }));
      return { slot: 1, blockTime: 10, meta: { err: null, innerInstructions, preTokenBalances: pre }, transaction: { message: { header: { numRequiredSignatures: signers.length }, getAccountKeys: () => ({ get: (i: number) => keys[i], length: keys.length }), compiledInstructions: compiled } } } as any;
    };
    /** the builder's shape: claim P into a fresh account, burn floor(P/2), the rest to the claimer's account */
    const shape = (c: Ix, f: PublicKey, P: bigint, extra: Ix[] = []) => [c, ...extra, burn(f, P / 2n), transfer(f, account, P - P / 2n)];
    const W = { account: account.toBase58(), mint: mint.toBase58(), claimer: claimer.toBase58(), configs: new Set([config.toBase58()]) };
    const ok = (n: bigint) => ({ amount: n, withClaim: true, other: 0n, unproven: 0n });
    const no = (n: bigint, other = 0n) => ({ amount: 0n, withClaim: false, other, unproven: n });
    const f = () => Keypair.generate().publicKey;
    // the three claim kinds, as the site builds them: counted exactly
    let a = f(); const good = tx(shape(claim("fee", a, 1000n), a, 1000n));
    expect(burnsIn(good, W)).to.deep.eq(ok(500n));
    a = f(); expect(burnsIn(tx(shape(claim("surplus", a, 7n), a, 7n)), W)).to.deep.eq(ok(3n));
    a = f(); expect(burnsIn(tx(shape(claim("position", a, 80n), a, 80n)), W)).to.deep.eq(ok(40n));
    // the partner's first case: another claimer's claim (it signs, ours does not), read for our account
    const other = Keypair.generate().publicKey;
    a = f(); expect(burnsIn(tx([claim("fee", a, 1000n, { by: other }), burn(a, 500n), transfer(a, account, 1n, other), transfer(a, f(), 499n, other)], { signers: [other] }), W)).to.deep.eq(no(500n));
    // ... and the claimer named in the claim but not signing it
    a = f(); expect(burnsIn(tx(shape(claim("fee", a, 1000n), a, 1000n), { signers: [other] }), W)).to.deep.eq(no(500n));
    // the partner's second case: the fresh account funded by a wallet, the claim pays nothing
    a = f(); expect(burnsIn(tx([transfer(f(), a, 1000n, other), claim("fee", a, 0n), burn(a, 500n), transfer(a, account, 500n)], { signers: [claimer, other] }), W)).to.deep.eq(no(500n));
    // a positive payout plus any other inflow (a transfer, a mint) is not proven either
    a = f(); expect(burnsIn(tx([transfer(f(), a, 10n, other), ...shape(claim("fee", a, 1000n), a, 1000n)], { signers: [claimer, other] }), W)).to.deep.eq(no(500n));
    a = f(); expect(burnsIn(tx(shape(claim("fee", a, 1000n), a, 1000n, [mintTo(a, 10n)])), W)).to.deep.eq(no(500n));
    // another split, the rest sent elsewhere, an account that held the mint before, another mint, another config, a claim
    // made through another program (an inner instruction), an unsupported instruction
    a = f(); expect(burnsIn(tx([claim("fee", a, 1000n), burn(a, 600n), transfer(a, account, 400n)]), W)).to.deep.eq(no(600n));
    a = f(); expect(burnsIn(tx([claim("fee", a, 1000n), burn(a, 500n), transfer(a, f(), 500n)]), W)).to.deep.eq(no(500n));
    a = f(); expect(burnsIn(tx(shape(claim("fee", a, 1000n), a, 1000n), { held: [{ account: a, amount: "5" }] }), W)).to.deep.eq(no(500n));
    a = f(); expect(burnsIn(tx(shape(claim("fee", a, 1000n, { m: f() }), a, 1000n)), W)).to.deep.eq(no(500n));
    a = f(); expect(burnsIn(tx(shape(claim("fee", a, 1000n, { cfg: f() }), a, 1000n)), W)).to.deep.eq(no(500n));
    expect(burnsIn(tx(shape(claim("fee", a, 1000n, { cfg: f() }), a, 1000n)), { ...W, configs: null }), "no config list: the claimer binds it").to.deep.eq(ok(500n));
    a = f(); expect(burnsIn(tx([wrap(claim("fee", a, 1000n)), burn(a, 500n), transfer(a, account, 500n)]), W)).to.deep.eq(no(500n));
    a = f(); expect(burnsIn(tx(shape(claim("fee", a, 1000n, { disc: SWAP2 }), a, 1000n)), W)).to.deep.eq({ amount: 0n, withClaim: false, other: 0n, unproven: 0n });
    // a swap next to an ordinary burn from the fee claimer's account: other; a claim into that account itself, then a
    // burn from it: other (earlier tokens could be burned); no header: no signer is known, nothing is proven
    const swapAndBurn = tx([claim("fee", account, 0n, { disc: SWAP2 }), burn(account, 7n)]);
    expect(burnsIn(swapAndBurn, W)).to.deep.eq({ amount: 0n, withClaim: false, other: 7n, unproven: 0n });
    expect(burnsIn(tx([claim("fee", account, 9n), burn(account, 4n), transfer(account, account, 5n)], { held: [{ account, amount: "1000" }] }), W)).to.deep.eq(no(4n));
    a = f(); const headless = tx(shape(claim("fee", a, 1000n), a, 1000n)); delete headless.transaction.message.header;
    expect(burnsIn(headless, W)).to.deep.eq(no(500n));
    a = f(); const elsewhere = tx([claim("fee", a, 1000n), burn(f(), 3n)]);
    const A = account.toBase58(), M = mint.toBase58();
    // the walk: newest first from the RPC, stored oldest first; a later pass reads only what is newer than its head
    const chain: Record<string, any> = { s1: good, s2: swapAndBurn, s3: elsewhere };
    let sigs = [{ signature: "s2", slot: 2, err: null }, { signature: "s1", slot: 1, err: null }];
    const deps = { getSignatures: async (_a: PublicKey, o: { until?: string }) => (o.until ? sigs.slice(0, sigs.findIndex((x) => x.signature === o.until)) : sigs), readTx: async (s: string) => chain[s] };
    const target = { mint: M, claimer: claimer.toBase58(), configs: [config.toBase58()] };
    expect(await pairedBurnPass(deps, store, target)).eq(2);
    sigs = [{ signature: "s3", slot: 3, err: null }, ...sigs];
    expect(await pairedBurnPass(deps, store, target)).eq(0);
    const saved = (await readPairedBurns(store))!;
    expect(saved.burns.map((b) => [b.signature, b.amountRaw, b.kind])).to.deep.eq([["s1", "500", "claim"], ["s2", "7", "other"]]);
    // a walk saved by an earlier parser version (or for other configs) is never reused: rebuilt from the start
    await store.setMeta("paired_burns", JSON.stringify({ ...saved, version: 1, burns: [{ signature: "old", slot: 0, blockTime: null, amountRaw: "999", withClaim: true }] }));
    await pairedBurnPass(deps, store, target);
    expect((await readPairedBurns(store))!.burns.map((b) => b.signature)).to.deep.eq(["s1", "s2"]);
    await pairedBurnPass(deps, store, { ...target, configs: [Keypair.generate().publicKey.toBase58()] });
    expect((await readPairedBurns(store))!.burns.map((b) => [b.signature, b.kind])).to.deep.eq([["s1", "unproven"], ["s2", "other"]]);
    await pairedBurnPass(deps, store, target);
    expect(saved).to.include({ head: "s3", complete: true, account: A });
    // an unreadable transaction stops the pass at it: retried, never skipped
    sigs = [{ signature: "s4", slot: 4, err: null }, ...sigs];
    await pairedBurnPass({ ...deps, readTx: async (s: string) => (s === "s4" ? null : chain[s]) }, store, target);
    expect((await readPairedBurns(store))!).to.include({ head: "s3", complete: false });
  });

  it("a burn-view outage keeps the paired launches: the kept identity values them, and without it the totals are unknown (F4)", async () => {
    const store = await freshStore();
    const cometailMint = key(), cometailPool = key(), w1 = key();
    const cometail = token({ mint: cometailMint, stage: "graduated", dammPool: cometailPool });
    const coin = token({ quoteMint: cometailMint, quoteDecimals: 6 });
    await store.upsertTokens([cometail, coin]);
    await store.insertTrades([trade(cometailPool, w1, "2000000000", "damm", { slot: 10, baseAmountRaw: "10000000000000", signature: "r1" }), trade(coin.dbcPool, w1, "10000000000000", "curve", { slot: 10, idx: 1, signature: "r1" })]);
    for (const p of [cometail.dbcPool, cometailPool, coin.dbcPool]) await store.setPoolCursor(p, { head: "h", tail: null, target: null, newHead: null, status: "ok" });
    await store.setMeta("tokens_scanned_at", "1000");
    const down = async () => ({ status: "unavailable" });
    const kept = await statsViewer(blindChain, store, { cluster: "test", team: [], feeIndex: null, burnView: down, tailView: null, pairedIdentity: () => ({ mint: cometailMint, pool: cometailPool }) })() as any;
    expect(kept.trading).to.include({ volumeLamports: "4000000000", pairedVolumeLamports: "2000000000", pairedIdentity: "known" });
    const unknown = await statsViewer(blindChain, store, { cluster: "test", team: [], feeIndex: null, burnView: down, tailView: null, pairedIdentity: () => undefined })() as any;
    expect(unknown.trading).to.include({ volumeLamports: null, outsideVolumeLamports: null, pairedVolumeLamports: null, pairedIdentity: "unknown" });
    // a program that is not set up at all: no paired quote exists, the SOL totals stand
    const none = await statsViewer(blindChain, store, { cluster: "test", team: [], feeIndex: null, burnView: async () => ({ status: "not-set-up" }), tailView: null })() as any;
    expect(none.trading).to.include({ volumeLamports: "2000000000", pairedIdentity: "none" });
  });

  it("a $COMETAIL leg with an unknown side is never skipped for an older price; its known SOL still counts as routed (F5)", async () => {
    const store = await freshStore();
    const cometailMint = key(), cometailPool = key(), w1 = key();
    const cometail = token({ mint: cometailMint, stage: "graduated", dammPool: cometailPool });
    const coin = token({ quoteMint: cometailMint, quoteDecimals: 6 });
    await store.upsertTokens([cometail, coin]);
    const old = trade(cometailPool, w1, "1000000000", "damm", { slot: 5, baseAmountRaw: "10000000000000" });
    // the route's own $COMETAIL leg: 9 SOL known, its $COMETAIL side missing
    const leg = trade(cometailPool, w1, "9000000000", "damm", { slot: 10, baseAmountRaw: undefined, signature: "route" });
    const paired = trade(coin.dbcPool, w1, "10000000000000", "curve", { slot: 10, idx: 1, signature: "route" });
    await store.insertTrades([old, leg, paired]);
    for (const p of [cometail.dbcPool, cometailPool, coin.dbcPool]) await store.setPoolCursor(p, { head: "h", tail: null, target: null, newHead: null, status: "ok" });
    await store.setMeta("tokens_scanned_at", "1000");
    const v: any = await statsViewer(blindChain, store, { cluster: "test", team: [], feeIndex: null, burnView: null, tailView: null, pairedIdentity: () => ({ mint: cometailMint, pool: cometailPool }) })();
    expect(v.launches.list.find((l: any) => l.mint === coin.mint).volumeSolLamports, "not the older 1 SOL per 10M").eq(null);
    expect(v.trading).to.include({ pairedVolumeLamports: null, pairedRoutedLamports: "9000000000" });
  });
});
