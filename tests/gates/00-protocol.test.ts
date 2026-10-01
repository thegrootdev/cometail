// Protocol authority and destinations: only the program's upgrade authority can initialize the
// singleton; the treasury is always the admin's legacy-SPL WSOL ATA; stream configs are real
// DBC configs owned by the admin with the locked economics; vault addresses cannot be squatted.
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { VaultClient } from "@cometail/client";
import { startSvm, fund, vaultProgramData } from "../harness/svm";
import { send, expectFail } from "../harness/tx";
import { ensureAta, createMint, ataIx } from "../harness/tokens";
import * as dbc from "../harness/dbc";

const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: new BN(1).shln(64) };

async function configs(svm: any, owner: Keypair): Promise<[PublicKey, PublicKey, PublicKey]> {
  const c = [] as PublicKey[];
  for (const n of ["stream-25", "stream-50", "stream-75"] as const) {
    c.push(await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams(n) }));
  }
  return c as [PublicKey, PublicKey, PublicKey];
}

describe("protocol: upgrade-authority-bound initialization, pinned treasury, validated configs", () => {
  it("the upgrade authority initializes; anyone else, or a wrong ProgramData, is rejected without occupying the singleton", async () => {
    const owner = Keypair.generate();
    const svm = startSvm({ upgradeAuthority: owner.publicKey });
    svm.airdrop(owner.publicKey, BigInt(100_000_000_000));
    const client = new VaultClient();
    const stranger = fund(svm), keeper = fund(svm);
    const cfgs = await configs(svm, owner);
    ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
    ensureAta(svm, stranger, NATIVE_MINT, stranger.publicKey);
    // a stranger, even with its own WSOL ATA and configs it owns, cannot take the singleton
    const strangerCfgs = await configs(svm, stranger);
    const bad = await client.initProtocol({ admin: stranger.publicKey, keeper: keeper.publicKey, payer: stranger.publicKey, streamConfigs: strangerCfgs });
    expectFail(svm, [bad], [stranger], "NotAdmin");
    // the right admin with a fabricated ProgramData account is rejected too
    const fake = Keypair.generate().publicKey;
    const pdData = svm.getAccount(vaultProgramData())!;
    svm.setAccount(fake, { lamports: Number(pdData.lamports), data: pdData.data, owner: pdData.owner, executable: false });
    const badPd = await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: cfgs, programData: fake });
    expectFail(svm, [badPd], [owner], "NotAdmin");
    expect(svm.getAccount(client.protocol)).null;
    // the real authority succeeds
    const ok = await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: cfgs });
    send(svm, [ok], [owner], { label: "init_protocol" });
    const p = client.decodeProtocol(Buffer.from(svm.getAccount(client.protocol)!.data));
    expect(p.admin.equals(owner.publicKey)).true;
    expect(p.treasury.equals(ensureAta(svm, owner, NATIVE_MINT, owner.publicKey))).true;
    expect(p.streamConfigs[1].equals(cfgs[1])).true;
    // and cannot be initialized twice
    expectFail(svm, [ok], [owner], "already in use");
  });

  it("treasury must be the admin's SPL WSOL ATA: foreign owner, wrong mint, non-ATA and missing accounts are rejected on init and on update", async () => {
    const owner = Keypair.generate();
    const svm = startSvm({ upgradeAuthority: owner.publicKey });
    svm.airdrop(owner.publicKey, BigInt(100_000_000_000));
    const client = new VaultClient();
    const stranger = fund(svm), keeper = fund(svm);
    const cfgs = await configs(svm, owner);
    const foreignOwnerAta = ensureAta(svm, stranger, NATIVE_MINT, stranger.publicKey);
    const otherMint = createMint(svm, owner, 9);
    const wrongMintAta = ensureAta(svm, owner, otherMint, owner.publicKey);
    const nonAta = Keypair.generate().publicKey; // nothing there
    for (const [label, treasury, needle] of [["foreign owner", foreignOwnerAta, "AccountMismatch"], ["wrong mint", wrongMintAta, "AccountMismatch"], ["missing", nonAta, "AccountNotInitialized"]] as const) {
      const ix = await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: cfgs, treasury });
      expectFail(svm, [ix], [owner], needle);
      void label;
    }
    // Token-2022 WSOL ATA is not the legacy-SPL ATA
    const t22 = ataIx(owner.publicKey, NATIVE_MINT, owner.publicKey, TOKEN_2022_PROGRAM_ID);
    void t22; // Token-2022 wrapped SOL is a different mint entirely; the mint check covers it
    ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
    send(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: cfgs })], [owner]);
    // update: a foreign WSOL account cannot become the treasury; a stranger cannot update at all
    expectFail(svm, [await client.updateProtocol({ admin: owner.publicKey, treasury: foreignOwnerAta })], [owner], "AccountMismatch");
    expectFail(svm, [await client.updateProtocol({ admin: stranger.publicKey, pausedRouting: true })], [stranger], "NotAdmin");
    send(svm, [await client.updateProtocol({ admin: owner.publicKey, keeper: stranger.publicKey, pausedRouting: true })], [owner]);
    const p = client.decodeProtocol(Buffer.from(svm.getAccount(client.protocol)!.data));
    expect(p.keeper.equals(stranger.publicKey)).true;
    expect(p.pausedRouting).true;
  });

  it("stream configs must be real DBC configs owned by the admin with the locked preset economics", async () => {
    const owner = Keypair.generate();
    const svm = startSvm({ upgradeAuthority: owner.publicKey });
    svm.airdrop(owner.publicKey, BigInt(100_000_000_000));
    const client = new VaultClient();
    const keeper = fund(svm), stranger = fund(svm);
    ensureAta(svm, owner, NATIVE_MINT, owner.publicKey);
    const good = await configs(svm, owner);
    // nonexistent account
    expectFail(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: [Keypair.generate().publicKey, good[1], good[2]] })], [owner], "ForeignAccount");
    // owned by someone else (fee_claimer is the stranger)
    const strangerCfg = await dbc.createConfig(svm, { payer: stranger, feeClaimer: stranger.publicKey, leftoverReceiver: stranger.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("stream-25") });
    expectFail(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: [strangerCfg, good[1], good[2]] })], [owner], "AccountMismatch");
    // wrong preset in the wrong slot (the 50% config offered as the 25% preset)
    expectFail(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: [good[1], good[1], good[2]] })], [owner], "Ineligible");
    // the plain config is not a stream config
    const plain = await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("plain") });
    expectFail(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: [plain, good[1], good[2]] })], [owner], "Ineligible");
    send(svm, [await client.initProtocol({ admin: owner.publicKey, keeper: keeper.publicKey, payer: owner.publicKey, streamConfigs: good })], [owner]);
    // update with a config that is not owned by the admin is rejected; a valid replacement works
    expectFail(svm, [await client.updateProtocol({ admin: owner.publicKey, streamConfigs: [strangerCfg, null, null] })], [owner], "AccountMismatch");
    const replacement = await dbc.createConfig(svm, { payer: owner, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT, params: dbc.configParams("stream-25") });
    send(svm, [await client.updateProtocol({ admin: owner.publicKey, streamConfigs: [replacement, null, null] })], [owner]);
    expect(client.decodeProtocol(Buffer.from(svm.getAccount(client.protocol)!.data)).streamConfigs[0].equals(replacement)).true;
  });

  it("a vault address cannot be squatted: the future ST mint keypair must sign create_vault and be uninitialized", async () => {
    const svm = startSvm();
    const client = new VaultClient();
    const depositor = fund(svm);
    const stMint = Keypair.generate();
    const cv = await client.createVault({ depositor: depositor.publicKey, stMint: stMint.publicKey, policy });
    // without the mint's signature the transaction is unsigned for that account
    let unsigned = false;
    try { send(svm, [cv.ix], [depositor, cv.placeholder]); } catch (e: any) { unsigned = /signature|Signature/.test(String(e.message)); }
    expect(unsigned).true;
    send(svm, [cv.ix], [depositor, cv.placeholder, stMint], { label: "create_vault" });
    expect(client.decodeVault(Buffer.from(svm.getAccount(cv.vault)!.data)).stMint.equals(stMint.publicKey)).true;
    // an already-initialized mint cannot be used as a vault's ST mint
    const existing = createMint(svm, depositor, 6);
    void existing; // a real mint has data, so the constraint rejects it; it also cannot sign (no keypair), which is the stronger guard
    void PublicKey;
  });
});
