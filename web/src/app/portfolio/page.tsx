"use client";
// Portfolio: the wallet's launches, its vaults, and its locked positions.
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Shell, Card } from "@/components/Shell";
import { nav } from "@/content/cometail";
import { api } from "@/lib/api";
import { poolsByCreator } from "@/lib/dbc";
import { cpAmm } from "@/lib/damm";
import { useLoad } from "@/lib/hooks";
import { short, sol } from "@/lib/format";

export default function PortfolioPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58() ?? null;
  const { data, loading } = useLoad(async () => {
    if (!publicKey) return null;
    const [pools, positions, vaults] = await Promise.all([poolsByCreator(connection, publicKey), cpAmm(connection).getPositionsByUser(publicKey), api.vaults()]);
    return { pools, positions, vaults: (vaults?.vaults ?? []).filter((v) => String(v.data.depositor) === me) };
  }, [me]);
  return (
    <Shell>
      <h1 className="text-4xl font-extrabold">{nav.portfolio}</h1>
      {!publicKey && <p className="mt-6 text-starlight/60">Connect a wallet.</p>}
      {publicKey && loading && <p className="mt-6 text-starlight/60">Loading…</p>}
      {data && (
        <div className="mt-6 grid gap-6 md:grid-cols-3">
          <Card title="Launches">
            {data.pools.length === 0 && <p className="text-sm text-starlight/60">None.</p>}
            <ul className="space-y-2 text-sm">{data.pools.map(({ pool, state }) => <li key={pool.toBase58()}><Link className="text-ion" href={`/token/${new PublicKey(state.baseMint).toBase58()}`}>{short(new PublicKey(state.baseMint).toBase58())}</Link> · {sol(state.creatorQuoteFee.toString())} claimable</li>)}</ul>
          </Card>
          <Card title="Vaults">
            {data.vaults.length === 0 && <p className="text-sm text-starlight/60">None.</p>}
            <ul className="space-y-2 text-sm">{data.vaults.map((v) => <li key={v.vault}><Link className="text-ion" href={`/vault/${v.vault}`}>{short(v.vault)}</Link> · {Object.keys(v.data.status ?? {})[0]} · {sol(String(v.data.accounting?.toDepositor ?? 0))} paid out</li>)}</ul>
          </Card>
          <Card title="Locked positions">
            {data.positions.length === 0 && <p className="text-sm text-starlight/60">None.</p>}
            <ul className="space-y-2 text-sm">{data.positions.map((p) => <li key={p.position.toBase58()}>{short(p.position.toBase58())} in pool {short(new PublicKey(p.positionState.pool).toBase58())}</li>)}</ul>
          </Card>
        </div>
      )}
      {data && <p className="mt-6 text-sm"><Link href="/sell" className="text-dust">{nav.sell}</Link></p>}
    </Shell>
  );
}
