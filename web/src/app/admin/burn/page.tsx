"use client";
// The burn program's setup: one signature from the program's upgrade authority (your wallet). The program
// requires that signer to be its upgrade authority, pins the $COMETAIL mint, its DAMM v2 pool (and that
// pool's fee settings) and the protocol treasury, and creates its token accounts; the signer pays their
// rent. This page reads every precondition from the chain, shows what setup will pin, simulates, sends,
// then reads the program's state back and compares field by field.
import { useCallback, useEffect, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { BurnClient, BURN_PROGRAM_ID } from "@cometail/client";
import { Shell, Card, ConnectWallet } from "@/components/Shell";
import { PageHeader } from "@/components/Experience";
import { CopyAddress } from "@/components/CopyAddress";
import { useTx } from "@/lib/hooks";
import { ADDRESSES, CLUSTER, COMETAIL_POOL, EXPLORER, OFFICIAL_MINT } from "@/lib/addresses";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";

export default function AdminBurnPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { run, status } = useTx();
  const client = new BurnClient(connection);
  const [authority, setAuthority] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<any | null | undefined>(undefined);
  const [poolCheck, setPoolCheck] = useState<{ ok: boolean; lines: string[] } | undefined>(undefined);
  const [simulation, setSimulation] = useState("");
  const [readError, setReadError] = useState("");
  const [sentSignature, setSentSignature] = useState("");
  const mint = OFFICIAL_MINT, pool = COMETAIL_POOL, treasury = ADDRESSES.treasury;

  const refresh = useCallback(async () => {
    setReadError("");
    try {
      const [data, st] = await Promise.all([connection.getAccountInfo(client.a.programData), connection.getAccountInfo(client.a.burnState)]);
      if (!data) setAuthority(null);
      else if (!data.owner.equals(new PublicKey(LOADER)) || data.data.length < 45 || data.data.readUInt32LE(0) !== 3) throw new Error("program data account is not an upgradeable-loader ProgramData account");
      else setAuthority(data.data[12] === 1 ? new PublicKey(data.data.subarray(13, 45)).toBase58() : null);
      setState(st ? client.decodeState(st.data) : null);
      if (pool && mint) {
        // the same rules the program enforces at setup, checked here first so a mistake shows before signing
        const p: any = await new CpAmm(connection).fetchPoolState(pool);
        // read with a DataView: the browser's Buffer polyfill has no 64-bit readers
        const fee = Uint8Array.from(p.poolFees.baseFee.baseFeeInfo.data as number[]);
        const cliff = new DataView(fee.buffer, fee.byteOffset, fee.byteLength).getBigUint64(0, true);
        const checks: [boolean, string][] = [
          [p.tokenAMint.equals(mint), `token A is $COMETAIL (${p.tokenAMint.toBase58()})`],
          [p.tokenBMint.toBase58() === WSOL, "token B is SOL"],
          [Number(p.collectFeeMode) === 2, `compounding pool (collect fee mode ${p.collectFeeMode})`],
          [cliff >= 10_000_000n && fee.subarray(8).every((b) => b === 0), `constant fee of at least 1% (${Number(cliff) / 1e7}%)`],
          [Number(p.poolFees.dynamicFee.initialized) === 0, "no dynamic fee"],
          [Number(p.poolStatus) === 0, "pool enabled"],
        ];
        setPoolCheck({ ok: checks.every(([ok]) => ok), lines: checks.map(([ok, t]) => `${ok ? "PASS" : "FAIL"} ${t}`) });
      } else setPoolCheck({ ok: false, lines: ["FAIL the site has no NEXT_PUBLIC_OFFICIAL_MINT or NEXT_PUBLIC_COMETAIL_POOL"] });
    } catch (e: any) { setReadError(String(e?.message ?? e)); }
  }, [connection]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setSimulation(""); }, [publicKey?.toBase58(), authority, state === null]);

  const isAuthority = !!publicKey && authority === publicKey.toBase58();
  const build = useCallback(async () => {
    if (!publicKey || !mint || !pool) throw new Error("addresses missing");
    const tx = new Transaction().add(await client.setup({ authority: publicKey, cometailMint: mint, pool, treasury }));
    tx.feePayer = publicKey;
    return tx;
  }, [publicKey?.toBase58()]);
  const simulate = async () => {
    try {
      const tx = await build();
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const res = await connection.simulateTransaction(tx);
      setSimulation(res.value.err ? `simulation FAILED: ${JSON.stringify(res.value.err)} ${(res.value.logs ?? []).filter((l) => /Error|failed/.test(l)).slice(-3).join(" | ")}` : `simulation OK: ${res.value.unitsConsumed ?? "?"} compute units; nothing was sent`);
    } catch (e: any) { setSimulation(`simulation FAILED: ${String(e?.message ?? e)}`); }
  };
  const sign = async () => { const sig = await run(build, [], 300_000); if (sig) { setSentSignature(sig); await refresh(); } };
  const ready = isAuthority && state === null && poolCheck?.ok && simulation.startsWith("simulation OK");
  const readback = state ? [
    ["$COMETAIL mint", state.cometailMint.toBase58(), mint?.toBase58()],
    ["pool", state.pool.toBase58(), pool?.toBase58()],
    ["treasury", state.treasury.toBase58(), treasury.toBase58()],
    ["reserve", state.reserve.toBase58(), client.a.reserve.toBase58()],
    ["set up by", state.setupBy.toBase58(), authority ?? "?"],
  ] : [];

  return (
    <Shell>
      <PageHeader eyebrow="Admin" title="Burn program setup" body={`One signature from the burn program's upgrade authority on ${CLUSTER}. Nothing here is for users.`} />
      <Card title="1. Wallet">
        <ConnectWallet />
        {publicKey && <p className="mt-2 text-sm">Connected {publicKey.toBase58()} {isAuthority ? "= the program's upgrade authority" : authority ? `is NOT the upgrade authority ${authority}` : ""}</p>}
      </Card>
      <Card title="2. Preconditions (read from the chain)">
        {readError && <p className="mb-2 text-sm wrap-anywhere">Could not read the chain: {readError} <button className="pill" onClick={() => void refresh()}>Retry</button></p>}
        <ul className="text-sm space-y-1 wrap-anywhere">
          <li>program {BURN_PROGRAM_ID.toBase58()} upgrade authority: {authority === undefined ? "reading" : authority ?? "none (not deployed, or immutable)"}</li>
          <li>burn state {client.a.burnState.toBase58()}: {state === undefined ? "reading" : state === null ? "not set up yet" : "already set up"}</li>
          {poolCheck?.lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      </Card>
      <Card title="3. What setup will pin">
        <ul className="text-sm space-y-1 wrap-anywhere">
          <li><span className="opacity-70">$COMETAIL mint:</span> {mint ? <CopyAddress address={mint.toBase58()} label="Mint" /> : "missing"}</li>
          <li><span className="opacity-70">$COMETAIL/SOL pool:</span> {pool ? <CopyAddress address={pool.toBase58()} label="Pool" /> : "missing"}</li>
          <li><span className="opacity-70">protocol treasury (receives the other half):</span> <CopyAddress address={treasury.toBase58()} label="Account" /></li>
          <li><span className="opacity-70">claimer (the new launch configs&apos; fee claimer):</span> <CopyAddress address={client.a.claimer.toBase58()} label="Claimer" /></li>
          <li><span className="opacity-70">burn reserve:</span> <CopyAddress address={client.a.reserve.toBase58()} label="Reserve" /></li>
        </ul>
        <p className="mt-2 text-xs opacity-70">Compare every address with the mainnet manifest before signing. Setup can run once; none of these can change afterwards. Your wallet pays the rent of the program&apos;s five accounts, about 0.01 SOL.</p>
      </Card>
      {state === null && (
        <Card title="4. Simulate, then sign">
          <div className="flex gap-2">
            <button className="pill" onClick={simulate} disabled={!isAuthority}>Simulate</button>
            <button className="pill" onClick={sign} disabled={!ready || status.state === "sending"}>Sign setup with the wallet</button>
          </div>
          {simulation && <p className="mt-2 text-sm">{simulation}</p>}
          {status.state === "sending" && <p className="mt-2 text-sm">Waiting for the wallet and the confirmation.</p>}
          {status.state === "error" && <p className="mt-2 text-sm">Failed: {status.message}</p>}
        </Card>
      )}
      {sentSignature && <Card title="Sent"><p className="text-sm">setup signature: <a href={EXPLORER("tx", sentSignature)} target="_blank" rel="noreferrer">{sentSignature}</a></p></Card>}
      {state && (
        <Card title="Burn program on chain">
          <ul className="text-sm space-y-1 wrap-anywhere">
            {readback.map(([what, actual, expected]) => <li key={what}>{actual === expected ? "PASS" : "FAIL"} {what}: {actual}{actual === expected ? "" : ` (expected ${expected})`}</li>)}
            <li>fee numerator pinned: {state.feeNumerator.toString()} (1e9 = 100%)</li>
          </ul>
        </Card>
      )}
    </Shell>
  );
}
