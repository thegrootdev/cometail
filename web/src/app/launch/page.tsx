"use client";
// The front door: a plain launch on the protocol's config. The creator's wallet is the pool
// creator, so the tail belongs to it from the first trade.
import { useState } from "react";
import Link from "next/link";
import { Keypair } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { Shell, Card } from "@/components/Shell";
import { plainLaunch } from "@/content/cometail";
import { launchTx } from "@/lib/dbc";
import { useTx } from "@/lib/hooks";
import { EXPLORER } from "@/lib/addresses";

export default function LaunchPage() {
  const { connection } = useConnection();
  const { run, status, connected, publicKey } = useTx();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [firstBuy, setFirstBuy] = useState("");
  const [mint, setMint] = useState<string | null>(null);
  const valid = name.trim().length > 0 && name.length <= 32 && symbol.trim().length > 0 && symbol.length <= 10 && uri.length <= 200;
  const submit = async () => {
    const kp = Keypair.generate();
    const lamports = firstBuy ? new BN(Math.round(Number(firstBuy) * 1e9)) : undefined;
    const sig = await run(() => launchTx(connection, { payer: publicKey!, baseMint: kp.publicKey, name: name.trim(), symbol: symbol.trim().toUpperCase(), uri: uri.trim(), firstBuyLamports: lamports }), [kp]);
    if (sig) setMint(kp.publicKey.toBase58());
  };
  return (
    <Shell>
      <h1 className="text-4xl font-extrabold">{plainLaunch.title}</h1>
      <p className="mt-2 max-w-2xl text-starlight/70">{plainLaunch.intro}</p>
      <div className="mt-6 grid gap-6 md:grid-cols-[2fr_1fr]">
        <Card>
          <label className="block text-sm">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2" placeholder="Comet" /></label>
          <label className="mt-4 block text-sm">Symbol<input value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={10} className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2" placeholder="COMET" /></label>
          <label className="mt-4 block text-sm">Metadata URL<input value={uri} onChange={(e) => setUri(e.target.value)} maxLength={200} className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2" placeholder="https://…/token.json (name, symbol, image, description)" /></label>
          <label className="mt-4 block text-sm">First buy, SOL (optional)<input value={firstBuy} onChange={(e) => setFirstBuy(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2" placeholder="0" /></label>
          <button disabled={!valid || !connected || status.state === "sending"} onClick={submit} className="mt-6 rounded-full bg-ion px-6 py-3 font-semibold text-night disabled:opacity-40">
            {status.state === "sending" ? "Launching…" : plainLaunch.title}
          </button>
          {!connected && <p className="mt-3 text-sm text-starlight/60">Connect a wallet to launch.</p>}
          {status.state === "error" && <p className="mt-3 text-sm text-red-300">{status.message}</p>}
          {status.state === "done" && mint && (
            <p className="mt-3 text-sm">Launched. <Link href={`/token/${mint}`} className="text-ion">Open the token page</Link> · <a href={EXPLORER("tx", status.signature!)} target="_blank" rel="noreferrer" className="text-starlight/60">transaction</a></p>
          )}
        </Card>
        <Card title="What you get">
          <p className="text-sm text-starlight/80">{plainLaunch.creationFee}</p>
          <p className="mt-3 text-sm text-starlight/80">{plainLaunch.lock}</p>
        </Card>
      </div>
    </Shell>
  );
}
