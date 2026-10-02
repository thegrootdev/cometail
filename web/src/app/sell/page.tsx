"use client";
// "Sell your tail": scan the wallet for streams it owns, pick, choose a preset, launch.
// One transaction per step so a wallet shows exactly what each signature does.
import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { VaultClientStep6, deriveStream, handPositionNftToVaultIx } from "@cometail/client";
import { Shell, Card } from "@/components/Shell";
import { wizard, splits, product } from "@/content/cometail";
import { ADDRESSES, EXPLORER, DAMM_V2_CUSTOMIZABLE_CONFIG } from "@/lib/addresses";
import { dbcClient, poolsByCreator, MigrationProgress } from "@/lib/dbc";
import { cpAmm } from "@/lib/damm";
import { dbcRightsReasons, positionReasons } from "@/lib/eligibility";
import { useLoad, useTx } from "@/lib/hooks";
import { short, sol } from "@/lib/format";
import { deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";

type RightsStream = { kind: "rights"; pool: PublicKey; config: PublicKey; baseMint: PublicKey; progress: number; claimable: BN; reasons: string[]; creatorPos?: { position: PublicKey; nftAccount: PublicKey; nftMint: PublicKey } };
type PositionStream = { kind: "position"; pool: PublicKey; position: PublicKey; nftAccount: PublicKey; nftMint: PublicKey; baseMint: PublicKey; reasons: string[] };
type Stream = RightsStream | PositionStream;
const key = (s: Stream) => (s.kind === "rights" ? s.pool : s.position).toBase58();

function Wizard() {
  const params = useSearchParams();
  const preselect = params.get("pool");
  const { connection } = useConnection();
  const { run, status, publicKey } = useTx();
  const client = useMemo(() => new VaultClientStep6(connection), [connection]);
  const { data: streams, loading } = useLoad<Stream[]>(async () => {
    if (!publicKey) return [];
    const out: Stream[] = [];
    const dbc = dbcClient(connection);
    const pools = await poolsByCreator(connection, publicKey);
    const amm = cpAmm(connection);
    const positions = await amm.getPositionsByUser(publicKey);
    const positionByPool = new Map<string, any>();
    for (const p of positions) positionByPool.set(new PublicKey(p.positionState.pool).toBase58(), p);
    for (const { pool, state } of pools) {
      const config: any = await dbc.state.getPoolConfig(state.config);
      const reasons = config ? dbcRightsReasons(config, state) : ["config missing"];
      const progress = Number(state.migrationProgress);
      const s: RightsStream = { kind: "rights", pool, config: state.config, baseMint: state.baseMint, progress, claimable: new BN(state.creatorQuoteFee.toString()), reasons };
      if (progress === MigrationProgress.CreatedPool && config) {
        const option = Number(config.migrationFeeOption);
        const derived = deriveDammV2PoolAddress(option === 6 ? DAMM_V2_CUSTOMIZABLE_CONFIG : DAMM_V2_CUSTOMIZABLE_CONFIG, state.baseMint, NATIVE_MINT);
        const mine = positionByPool.get(derived.toBase58());
        if (mine) { s.creatorPos = { position: mine.position, nftAccount: mine.positionNftAccount, nftMint: new PublicKey(mine.positionState.nftMint) }; positionByPool.delete(derived.toBase58()); }
        else s.reasons.push("the creator position is not in this wallet");
      }
      out.push(s);
    }
    for (const p of positions) {
      const poolKey = new PublicKey(p.positionState.pool);
      if (!positionByPool.has(poolKey.toBase58())) continue; // bundled above
      const poolState: any = await amm.fetchPoolState(poolKey);
      out.push({ kind: "position", pool: poolKey, position: p.position, nftAccount: p.positionNftAccount, nftMint: new PublicKey(p.positionState.nftMint), baseMint: poolState.tokenAMint, reasons: positionReasons(poolState, p.positionState) });
    }
    return out;
  }, [publicKey?.toBase58()]);
  const [picked, setPicked] = useState<Set<string>>(new Set(preselect ? [preselect] : []));
  const [preset, setPreset] = useState(1);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [capSol, setCapSol] = useState("0.01");
  const [log, setLog] = useState<string[]>([]);
  const [vaultKey, setVaultKey] = useState<string | null>(null);
  const eligible = (streams ?? []).filter((s) => s.reasons.length === 0);
  const chosen = eligible.filter((s) => picked.has(key(s)));
  const ready = chosen.length > 0 && name.trim() && symbol.trim() && publicKey && status.state !== "sending";

  const launch = async () => {
    if (!publicKey) return;
    const stMint = Keypair.generate();
    const capQ64 = new BN(Math.round(Number(capSol) * 1e9 / 1e6)).shln(64); // lamports per raw unit of a 6-decimal token
    const policy = { maxSpendPerPeriod: new BN(5_000_000_000), periodSeconds: new BN(3600), maxOutstandingOrders: 4, maxBinsPerOrder: 20, maxPriceQ64: capQ64.isZero() ? new BN(1).shln(64) : capQ64 };
    const cv = await client.createVault({ depositor: publicKey, stMint: stMint.publicKey, policy });
    const step = async (label: string, build: () => Promise<Transaction>, signers: Keypair[] = []) => { const sig = await run(build, signers); setLog((l) => [...l, `${label}: ${sig ?? "failed"}`]); if (!sig) throw new Error(label); };
    try {
      await step("create vault", async () => new Transaction().add(cv.ix), [cv.placeholder, stMint]);
      const dbc = dbcClient(connection);
      let index = 0;
      for (const s of chosen) {
        if (s.kind === "rights") {
          const xfer = await dbc.creator.transferPoolCreator({ pool: s.pool, creator: publicKey, newCreator: cv.vault });
          if (s.progress === MigrationProgress.PreBondingCurve) {
            const dep = await client.depositDbcRights({ vault: cv.vault, depositor: publicKey, streamIndex: index, dbcPool: s.pool, dbcConfig: s.config, baseMint: s.baseMint });
            await step(`deposit rights ${short(s.baseMint.toBase58())}`, async () => new Transaction().add(...xfer.instructions, dep));
          } else {
            const derived = deriveDammV2PoolAddress(DAMM_V2_CUSTOMIZABLE_CONFIG, s.baseMint, NATIVE_MINT);
            const dep = await client.depositDbcRightsMigrated({ vault: cv.vault, depositor: publicKey, streamIndex: index, dbcPool: s.pool, dbcConfig: s.config, baseMint: s.baseMint, dammPool: derived, creatorPosition: s.creatorPos!.position, creatorNftAccount: s.creatorPos!.nftAccount });
            await step(`deposit rights + position ${short(s.baseMint.toBase58())}`, async () => new Transaction().add(...xfer.instructions, handPositionNftToVaultIx(s.creatorPos!.nftMint, publicKey, cv.vault), dep));
          }
        } else {
          const dep = await client.depositPosition({ vault: cv.vault, depositor: publicKey, streamIndex: index, dammPool: s.pool, position: s.position, nftMint: s.nftMint, nftAccount: s.nftAccount, baseMint: s.baseMint });
          await step(`deposit position ${short(s.position.toBase58())}`, async () => new Transaction().add(handPositionNftToVaultIx(s.nftMint, publicKey, cv.vault), dep));
        }
        index++;
      }
      const L = await client.launch({ vault: cv.vault, depositor: publicKey, stMint: stMint.publicKey, config: ADDRESSES.streamConfigs[preset], preset, streamIndex: index, metadata: { name: name.trim(), symbol: `${product.streamTickerPrefix}${symbol.trim().toUpperCase()}`, uri: uri.trim() } });
      await step("launch the stream token", async () => new Transaction().add(L.ix), [stMint]);
      setVaultKey(cv.vault.toBase58());
    } catch (e) { setLog((l) => [...l, `stopped: ${String((e as Error).message)}`]); }
  };

  return (
    <>
      <h1 className="text-4xl font-extrabold">{wizard.title}</h1>
      <p className="mt-2 max-w-2xl text-starlight/70">{wizard.intro}</p>
      {!publicKey && <p className="mt-6 text-starlight/60">Connect the wallet that owns the streams.</p>}
      {publicKey && (
        <div className="mt-6 grid gap-6 md:grid-cols-[3fr_2fr]">
          <div className="space-y-6">
            <Card title="1. Your streams">
              {loading && <p className="text-starlight/60">Scanning the wallet…</p>}
              {!loading && (streams ?? []).length === 0 && <p className="text-starlight/60">No DBC launches or locked positions found for this wallet.</p>}
              <ul className="space-y-2">
                {(streams ?? []).map((s) => {
                  const k = key(s); const ok = s.reasons.length === 0;
                  return (
                    <li key={k} className={`flex items-start gap-3 rounded-xl border border-starlight/10 p-3 ${ok ? "" : "opacity-60"}`}>
                      <input type="checkbox" disabled={!ok} checked={picked.has(k)} onChange={(e) => { const n = new Set(picked); e.target.checked ? n.add(k) : n.delete(k); setPicked(n); }} className="mt-1" />
                      <div className="text-sm">
                        <div>{s.kind === "rights" ? "Creator rights" : "Locked position"} · <Link href={`/token/${s.baseMint.toBase58()}`} className="text-ion">{short(s.baseMint.toBase58())}</Link>{s.kind === "rights" && <span className="text-starlight/60"> · {["bonding", "curve complete", "locked vesting", "graduated"][s.progress]} · {sol(s.claimable)} claimable</span>}</div>
                        {!ok && <div className="text-xs text-starlight/50">{s.reasons.join("; ")}</div>}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-xs text-starlight/50">{wizard.withdrawLock}</p>
            </Card>
            <Card title="2. Your share at graduation">
              <div className="grid gap-3 sm:grid-cols-3">
                {wizard.presets.map((p, i) => (
                  <button key={p.key} onClick={() => setPreset(i)} className={`rounded-xl border p-3 text-left ${preset === i ? "border-dust" : "border-starlight/15"}`}>
                    <div className="font-semibold text-dust">{p.label}</div>
                    <div className="mt-1 text-xs text-starlight/70">{p.body}</div>
                  </button>
                ))}
              </div>
            </Card>
            <Card title="3. The stream token">
              <label className="block text-sm">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2" /></label>
              <label className="mt-3 block text-sm">Symbol (shown as {product.streamTickerPrefix}SYMBOL)<input value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={9} className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2" /></label>
              <label className="mt-3 block text-sm">Metadata URL<input value={uri} onChange={(e) => setUri(e.target.value)} maxLength={200} className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2" /></label>
              <label className="mt-3 block text-sm">Highest price the buyback pays, SOL per token<input value={capSol} onChange={(e) => setCapSol(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2" /></label>
              <button disabled={!ready} onClick={launch} className="mt-5 rounded-full bg-dust px-6 py-3 font-semibold text-night disabled:opacity-40">{status.state === "sending" ? "Signing…" : wizard.title}</button>
              <p className="mt-3 text-xs text-starlight/50">{wizard.irreversible}</p>
              {log.length > 0 && <ul className="mt-4 space-y-1 text-xs text-starlight/70">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
              {status.state === "error" && <p className="mt-2 text-sm text-red-300">{status.message}</p>}
              {vaultKey && <p className="mt-3 text-sm">Launched. <Link href={`/vault/${vaultKey}`} className="text-ion">Open the vault</Link> · <a href={EXPLORER("address", vaultKey)} target="_blank" rel="noreferrer" className="text-starlight/60">explorer</a></p>}
            </Card>
          </div>
          <Card title="How the money moves">
            <ul className="space-y-3 text-sm text-starlight/80">
              <li>{splits.curve}</li><li>{splits.pool}</li><li>{splits.external}</li><li>{splits.cashout}</li><li>{splits.orderFees}</li>
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

export default function SellPage() {
  return <Shell><Suspense fallback={<p className="text-starlight/60">Loading…</p>}><Wizard /></Suspense></Shell>;
}
