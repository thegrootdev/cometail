"use client";
// The protocol's own fee claims, signed in the wallet that owns each one: partner trading fees on our
// configs' DBC pools, the partner's share of a finished curve's surplus, and the fees on the fee
// claimers' locked DAMM v2 positions. Each row names the wallet that must sign and the token account
// the claim lands in; a claim is simulated first and sent only by the connected wallet when it is that
// owner. Nothing here closes a token account: the admin's wrapped-SOL account is the protocol treasury
// the vault program pays into, and closing it would break every harvest.
import { useCallback, useEffect, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Shell, Card, ConnectWallet } from "@/components/Shell";
import { PageHeader } from "@/components/Experience";
import { CopyAddress } from "@/components/CopyAddress";
import { useTx } from "@/lib/hooks";
import { ADMIN, CLUSTER, EXPLORER } from "@/lib/addresses";
import { buildProtocolClaim, formatQuote, scanProtocolClaims, type ProtocolClaim, type ProtocolScan } from "@/lib/protocol-fees";

const KIND_LABEL: Record<ProtocolClaim["kind"], string> = {
  "dbc-partner-fee": "Partner trading fees on the curve",
  "dbc-partner-surplus": "Partner share of the curve's surplus",
  "damm-position-fee": "Fees on the locked liquidity position",
};
const symbolOf = (mint: PublicKey) => (mint.toBase58() === "So11111111111111111111111111111111111111112" ? "SOL" : mint.toBase58().slice(0, 4) + "…");

export default function AdminFeesPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { run, status } = useTx();
  const [scan, setScan] = useState<ProtocolScan | null>(null);
  const [scanError, setScanError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [simulations, setSimulations] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setScanning(true); setScanError("");
    try { setScan(await scanProtocolClaims(connection)); } catch (e: any) { setScanError(String(e?.message ?? e)); } finally { setScanning(false); }
  }, [connection]);
  useEffect(() => { refresh(); }, [refresh]);
  // a change of wallet or chain state invalidates earlier simulations
  useEffect(() => { setSimulations({}); }, [publicKey?.toBase58(), scan]);

  const build = useCallback(async (claim: ProtocolClaim) => {
    if (!publicKey) throw new Error("connect the wallet that owns this claim");
    if (!publicKey.equals(claim.claimer)) throw new Error(`this claim is signed by ${claim.claimer.toBase58()}, not the connected wallet`);
    const { instructions, removedCloses } = await buildProtocolClaim(connection, claim);
    if (instructions.some((ix) => ix.data.length >= 1 && ix.data[0] === 9 && /Token/.test(ix.programId.toBase58()))) throw new Error("a close instruction survived; refusing");
    const tx = new Transaction().add(...instructions);
    tx.feePayer = publicKey;
    return { tx, removedCloses };
  }, [connection, publicKey?.toBase58()]);

  const simulate = async (claim: ProtocolClaim) => {
    setActive(claim.id);
    try {
      const { tx, removedCloses } = await build(claim);
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const res = await connection.simulateTransaction(tx);
      const note = `${tx.instructions.length} instructions, ${removedCloses} close instruction${removedCloses === 1 ? "" : "s"} removed`;
      setSimulations((s) => ({ ...s, [claim.id]: res.value.err ? `simulation FAILED: ${JSON.stringify(res.value.err)} ${(res.value.logs ?? []).filter((l) => /Error|failed/.test(l)).slice(-3).join(" | ")}` : `simulation OK: ${res.value.unitsConsumed ?? "?"} compute units; ${note}` }));
    } catch (e: any) { setSimulations((s) => ({ ...s, [claim.id]: `simulation FAILED: ${String(e?.message ?? e)}` })); }
    finally { setActive(null); }
  };

  const claimNow = async (claim: ProtocolClaim) => {
    setActive(claim.id);
    try {
      const sig = await run(async () => (await build(claim)).tx, [], 300_000);
      if (sig) { setSent((s) => ({ ...s, [claim.id]: sig })); await refresh(); }
    } finally { setActive(null); }
  };

  const mine = (claim: ProtocolClaim) => !!publicKey && publicKey.equals(claim.claimer);
  // the claimer pays the fee and, when the destination is new, its rent: about 0.003 SOL; an empty wallet cannot sign a claim
  const MIN_LAMPORTS = 5_000_000n;
  const funded = (claim: ProtocolClaim) => (scan?.claimerLamports[claim.claimer.toBase58()] ?? 0n) >= MIN_LAMPORTS;
  const treasury = scan?.treasury;
  const treasuryOwnerIsAdmin = !!(treasury?.owner && ADMIN && treasury.owner.equals(ADMIN));

  return (
    <Shell>
      <PageHeader eyebrow="Admin" title="Protocol fees" body={`What the protocol can claim on ${CLUSTER}, each claim signed by the wallet that owns it. Nothing here is for users.`} />
      <Card title="1. Wallet">
        <ConnectWallet />
        {publicKey && <p className="mt-2 text-sm">Connected {publicKey.toBase58()}{ADMIN && publicKey.equals(ADMIN) ? " = admin wallet" : ""}</p>}
        {scan && scan.claimers.length > 0 && (
          <ul className="mt-2 text-sm space-y-1">
            {scan.claimers.map((c) => { const bal = scan.claimerLamports[c.toBase58()] ?? 0n; return (
              <li key={c.toBase58()}>claimer {c.toBase58()}{ADMIN && c.equals(ADMIN) ? " (admin)" : " (launch treasury)"} · holds {formatQuote(bal, 9, "SOL")}{bal < MIN_LAMPORTS ? " · needs about 0.01 SOL before it can sign a claim (fee plus the rent of a new token account)" : ""}</li>
            ); })}
          </ul>
        )}
        <p className="mt-2 text-xs opacity-70">Connect the wallet named on a row to claim it.</p>
      </Card>
      <Card title="2. Protocol treasury (the vault program pays here)">
        {treasury ? (
          <ul className="text-sm space-y-1">
            <li>account: <CopyAddress address={treasury.address.toBase58()} /> {treasury.exists ? "" : "(MISSING on chain)"}</li>
            <li>owner: {treasury.owner ? treasury.owner.toBase58() : "unknown"}{treasuryOwnerIsAdmin ? " = admin wallet" : ""}</li>
            <li>balance: {treasury.lamports === null ? "unknown" : formatQuote(treasury.lamports, 9, "SOL (wrapped)")}</li>
          </ul>
        ) : <p className="text-sm">{scanError ? `Could not read the chain: ${scanError}` : "Reading the chain."}</p>}
        <p className="form-notice mt-3" role="alert">
          <strong>Never close this wrapped-SOL account.</strong> Every harvest transfers the protocol&apos;s share into it by address; a closed account makes every harvest fail until it is recreated. To take SOL out, transfer wrapped SOL to another account or unwrap from a copy, never &quot;close&quot; or &quot;unwrap&quot; this one in a wallet.
        </p>
      </Card>
      <Card title="3. Claimable now">
        <div className="flex gap-2 items-center">
          <button className="pill" onClick={() => refresh()} disabled={scanning}>{scanning ? "Scanning the chain" : "Rescan"}</button>
          {scanError && <span className="text-sm">Could not read the chain: {scanError}</span>}
        </div>
        {scan && scan.warnings.length > 0 && <ul className="mt-2 text-xs opacity-70">{scan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        {scan && scan.claims.length === 0 && !scanning && <p className="mt-3 text-sm">Nothing to claim right now.</p>}
        <ul className="mt-3 space-y-4">
          {scan?.claims.map((claim) => (
            <li key={claim.id} className="rounded-xl border border-starlight/15 p-3">
              <p className="text-sm font-semibold text-dust">{KIND_LABEL[claim.kind]} · {claim.configLabel}</p>
              <ul className="mt-1 text-sm space-y-1">
                <li>amount: {formatQuote(claim.amountQuote, claim.quoteDecimals, symbolOf(claim.quoteMint))}{claim.amountBase > 0n ? ` plus ${claim.amountBase.toString()} raw base tokens` : ""}{claim.note ? ` (${claim.note})` : ""}</li>
                <li>pool: <CopyAddress address={claim.pool.toBase58()} />{claim.position ? <> · position <CopyAddress address={claim.position.toBase58()} /></> : null}</li>
                <li>signed by: {claim.claimer.toBase58()}{mine(claim) ? " (connected)" : ""}</li>
                <li>lands in: <CopyAddress address={claim.destination.toBase58()} /> ({claim.claimer.toBase58().slice(0, 4)}…&apos;s {symbolOf(claim.quoteMint) === "SOL" ? "wrapped-SOL" : "quote token"} account{claim.destinationExists ? "" : ", created by this claim"}){claim.amountBase > 0n ? "; base tokens in the claimer's token account for the base mint" : ""}</li>
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="pill" onClick={() => simulate(claim)} disabled={!mine(claim) || !funded(claim) || active !== null}>Simulate</button>
                <button className="pill" onClick={() => claimNow(claim)} disabled={!mine(claim) || active !== null || status.state === "sending" || !(simulations[claim.id] ?? "").startsWith("simulation OK")}>Claim with the wallet</button>
              </div>
              {!mine(claim) && <p className="mt-1 text-xs opacity-70">Connect {claim.claimer.toBase58()} to claim this.</p>}
              {mine(claim) && !funded(claim) && <p className="mt-1 text-xs opacity-70">This wallet holds no SOL for the fee; send it about 0.01 SOL first, then rescan.</p>}
              {simulations[claim.id] && <p className="mt-2 text-sm">{simulations[claim.id]}</p>}
              {active === claim.id && status.state === "sending" && <p className="mt-2 text-sm">Waiting for the wallet and the confirmation.</p>}
              {active === claim.id && status.state === "error" && <p className="mt-2 text-sm">Failed: {status.message}</p>}
              {sent[claim.id] && <p className="mt-2 text-sm">Sent: <a href={EXPLORER("tx", sent[claim.id])} target="_blank" rel="noreferrer">{sent[claim.id]}</a></p>}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs opacity-70">Each claim is built by the Meteora SDK for the claimer, then its unwrap step (a close of the wrapped-SOL account) is removed, so the fees stay as wrapped SOL in the claimer&apos;s token account. The dry run before signing is the same one every send on this site gets.</p>
      </Card>
    </Shell>
  );
}
