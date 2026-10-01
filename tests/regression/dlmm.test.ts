// Regression for spike 02: DLMM limit orders with a program-derived owner, against the live
// DLMM binary. Place, stranger cancel rejected, fill, cancel + close, partial fill, 50 bins
// in a v0 transaction with a lookup table.
import { BN } from "@coral-xyz/anchor";
import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { expect } from "chai";
import { startSvm, fund } from "../harness/svm";
import { send, expectFail, forward, loadForwarder, pdaSigner } from "../harness/tx";
import { createMint, ensureAta, mintTo, balance, wrapSol } from "../harness/tokens";
import * as dlmm from "../harness/dlmm";

async function setup() {
  const svm = startSvm({ withVaultProgram: false });
  loadForwarder(svm);
  const keeper = fund(svm), seller = fund(svm);
  const vault = pdaSigner("ladder");
  const st = createMint(svm, keeper, 6);
  const sellerSt = mintTo(svm, keeper, st, seller.publicKey, new BN(1_000_000_000_000));
  mintTo(svm, keeper, st, keeper.publicKey, new BN(1_000_000)); // the pair funder must hold token X
  const keeperWsol = wrapSol(svm, keeper, new BN(1_000_000_000));
  const init = await dlmm.initPairIx({ x: st, y: NATIVE_MINT, funder: keeper.publicKey, userTokenX: ensureAta(svm, keeper, st, keeper.publicKey), userTokenY: keeperWsol, binStep: 100, baseFactor: 1000 });
  send(svm, [init.ix], [keeper], { cu: 400_000, label: "dlmm.init_pair" });
  const pair = init.pair;
  expect(dlmm.getPair(svm, pair).tokenXMint.equals(st)).true;
  // vault WSOL pre-funded: the PDA never wraps SOL itself
  const vaultWsol = ensureAta(svm, keeper, NATIVE_MINT, vault.key);
  const vaultSt = ensureAta(svm, keeper, st, vault.key);
  send(svm, [
    require("@solana/web3.js").SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: vaultWsol, lamports: 10_000_000_000 }),
    require("@solana/spl-token").createSyncNativeInstruction(vaultWsol),
  ], [keeper]);
  // bin arrays the ladder will use (keeper pays rent)
  // bin-array initialization needs more than the 200k default compute
  for (const i of [-1, 0]) send(svm, [await dlmm.initBinArrayIx(pair, i, keeper.publicKey)], [keeper], { cu: 1_400_000, label: "dlmm.init_bin_array" });
  const sellerWsol = ensureAta(svm, seller, NATIVE_MINT, seller.publicKey);
  return { svm, keeper, seller, vault, st, pair, vaultWsol, vaultSt, sellerSt, sellerWsol };
}

describe("dlmm: limit-order bids owned by a PDA", () => {
  it("place via CPI, stranger cancel rejected, fill, cancel + close returns fills and fees", async () => {
    const h = await setup();
    const order = Keypair.generate();
    const bins = [-5, -4, -3, -2, -1].map((id) => ({ id, amount: new BN(1_000_000_000) }));
    const place = await dlmm.placeLimitOrderIx(h.svm, { pair: h.pair, order, owner: h.vault.key, sender: h.vault.key, payer: h.keeper.publicKey, userToken: h.vaultWsol, isAskSide: false, bins });
    const w0 = balance(h.svm, h.vaultWsol);
    send(h.svm, [forward(place, h.vault)], [h.keeper, order], { cu: 400_000, label: "dlmm.place_5" });
    expect(w0.sub(balance(h.svm, h.vaultWsol)).toString()).eq("5000000000");
    const lo = dlmm.getLimitOrder(h.svm, order.publicKey);
    expect(lo.owner.equals(h.vault.key)).true;
    expect(lo.binCount).eq(5);

    // a stranger (the seller) cannot cancel the vault's order
    const bad = await dlmm.cancelLimitOrderIx(h.svm, { pair: h.pair, order: order.publicKey, owner: h.seller.publicKey, ownerTokenX: h.sellerSt, ownerTokenY: h.sellerWsol, bins: [-5, -4, -3, -2, -1] });
    expectFail(h.svm, [bad], [h.seller], "InvalidLimitOrderOwner");

    // the seller sells into the ladder
    // the five 1-SOL bids at bins -5..-1 absorb about 5.15e9 raw ST; sell a little less so the swap never
    // runs past the provided bin arrays (swap2 is exact-in and would then demand the bitmap extension)
    const sw = await dlmm.swap2Ix(h.svm, { pair: h.pair, user: h.seller.publicKey, tokenIn: h.sellerSt, tokenOut: h.sellerWsol, amountIn: new BN(5_100_000_000), binIds: [-5, -4, -3, -2, -1, 0] });
    send(h.svm, [sw], [h.seller], { cu: 600_000, label: "dlmm.swap_fill" });
    expect(dlmm.getPair(h.svm, h.pair).activeId).lte(-1);

    // the vault settles: cancel returns the fills (ST), its fee share (WSOL) and rent
    const cancel = await dlmm.cancelLimitOrderIx(h.svm, { pair: h.pair, order: order.publicKey, owner: h.vault.key, ownerTokenX: h.vaultSt, ownerTokenY: h.vaultWsol, bins: [-5, -4, -3, -2, -1] });
    const close = await dlmm.closeLimitOrderIx(order.publicKey, h.vault.key, h.vault.key);
    const s0 = balance(h.svm, h.vaultSt), w1 = balance(h.svm, h.vaultWsol);
    // cancellation in the same slot/second as a fill hits LiquidityLocked: advance the clock first
    const clock = h.svm.getClock(); clock.slot = clock.slot + BigInt(2); clock.unixTimestamp = clock.unixTimestamp + BigInt(2); h.svm.setClock(clock);
    send(h.svm, [forward(cancel, h.vault), forward(close, h.vault)], [h.keeper], { cu: 400_000, label: "dlmm.cancel_close" });
    expect(balance(h.svm, h.vaultSt).sub(s0).gtn(0)).true;
    expect(balance(h.svm, h.vaultWsol).sub(w1).gtn(0)).true; // fee share in WSOL (OnlyY, ST is X)
    const closed = h.svm.getAccount(order.publicKey);
    expect(!closed || Number(closed.lamports) === 0).true; // a closed account lingers with zero lamports in LiteSVM
  });

  it("50 bins need a v0 transaction with a lookup table; legacy is too large", async () => {
    const h = await setup();
    const order = Keypair.generate();
    const bins = Array.from({ length: 50 }, (_, i) => ({ id: -50 + i, amount: new BN(1_000_000) }));
    const ix = forward(await dlmm.placeLimitOrderIx(h.svm, { pair: h.pair, order, owner: h.vault.key, sender: h.vault.key, payer: h.keeper.publicKey, userToken: h.vaultWsol, isAskSide: false, bins }), h.vault);
    // legacy size: message + 2 signatures (web3.js refuses to serialize above 1232 bytes)
    const legacyTx = new (require("@solana/web3.js").Transaction)().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
    legacyTx.feePayer = h.keeper.publicKey; legacyTx.recentBlockhash = h.svm.latestBlockhash();
    const legacyBytes = legacyTx.serializeMessage().length + 1 + 64 * 2;
    console.log(`      50-bin place: legacy ${legacyBytes} bytes`);
    // lookup table holding every static key, injected as an account
    const keys = Array.from(new Set(ix.keys.filter((k) => !k.isSigner).map((k) => k.pubkey.toBase58()))).map((k) => new PublicKey(k));
    const tableKey = Keypair.generate().publicKey;
    const table = new AddressLookupTableAccount({ key: tableKey, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: h.keeper.publicKey, addresses: keys } });
    const header = Buffer.alloc(56);
    header.writeUInt32LE(1, 0); // type: lookup table
    header.writeBigUInt64LE(BigInt("18446744073709551615"), 4);
    header.writeBigUInt64LE(BigInt(0), 12);
    header.writeUInt8(0, 20);
    header.writeUInt8(1, 21); h.keeper.publicKey.toBuffer().copy(header, 22);
    h.svm.setAccount(tableKey, { lamports: 10_000_000, owner: AddressLookupTableProgram.programId, executable: false, data: Buffer.concat([header, ...keys.map((k) => k.toBuffer())]) });
    h.svm.warpToSlot(h.svm.getClock().slot + BigInt(2)); // table entries extended in slot N are usable from N+1
    const msg = new TransactionMessage({ payerKey: h.keeper.publicKey, recentBlockhash: h.svm.latestBlockhash(), instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix] }).compileToV0Message([table]);
    const tx = new VersionedTransaction(msg);
    tx.sign([h.keeper, order]);
    console.log(`      50-bin place: v0 + lookup table ${tx.serialize().length} bytes`);
    expect(tx.serialize().length).lessThan(1233);
    expect(tx.serialize().length).lessThan(legacyBytes);
    const res = h.svm.sendTransaction(tx);
    if (res instanceof FailedTransactionMetadata) throw new Error(`v0 send failed: ${res.err()}\n${res.meta().logs().join("\n")}`);
    expect(dlmm.getLimitOrder(h.svm, order.publicKey).binCount).eq(50);
    void LiteSVM;
  });
});
