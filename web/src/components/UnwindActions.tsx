"use client";
// A launched vault seen by its depositor: the unwind window, and the unwind itself once the
// window has passed without graduation. The program decides; this shows the date and sends one
// instruction. After it, the streams leave through the same withdraw path an open vault uses.
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VaultClientStep6 } from "@cometail/client";
import { Card } from "./Shell";
import { vaultPage } from "@/content/cometail";
import { friendlyError } from "@/lib/errors";
import { useTx } from "@/lib/hooks";
import { EXPLORER } from "@/lib/addresses";
import { loadPool, MigrationProgress } from "@/lib/dbc";

/** Must match the program's UNWIND_WINDOW_SECONDS. */
export const UNWIND_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const KIND = (s: any) => (s?.kind ? Object.keys(s.kind)[0] : "");

export function UnwindActions({ vault, v, streams, onChange }: { vault: string; v: any; streams: any[]; onChange: () => void }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { run, status } = useTx();
  const [error, setError] = useState<string | null>(null);
  // the curve's own progress decides: a pool past its threshold graduates instead
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    if (!v?.dbcPool) return;
    loadPool(connection, new PublicKey(String(v.dbcPool))).then((p) => { if (live) setProgress(p ? p.progress : -1); }).catch(() => { if (live) setProgress(-1); });
    return () => { live = false; };
  }, [connection, v?.dbcPool]);
  const copy = vaultPage.unwind;
  const own = streams.find((s) => s.isOwn && KIND(s) === "dbcCreatorRights");
  const launchedAt = own ? Number(own.depositTs) : null;
  const isDepositor = !!publicKey && String(v.depositor) === publicKey.toBase58();
  if (!isDepositor || launchedAt === null) return null;
  const opensAt = launchedAt + UNWIND_WINDOW_SECONDS;
  const belowThreshold = progress === MigrationProgress.PreBondingCurve;
  const ready = belowThreshold && Math.floor(Date.now() / 1000) >= opensAt;
  const when = new Date(opensAt * 1000).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }) + " UTC";
  const unwind = async () => {
    setError(null);
    try {
      if (!publicKey || !own) return;
      const client = new VaultClientStep6(connection);
      await run(async () => {
        const ix = await client.unwind({ vault: new PublicKey(vault), depositor: publicKey, ownStream: new PublicKey(own.stream), dbcPool: new PublicKey(v.dbcPool), dbcConfig: new PublicKey(v.dbcConfig), incomeWsol: new PublicKey(v.incomeWsol), depositorWsol: new PublicKey(v.depositorWsol) });
        const { Transaction } = await import("@solana/web3.js");
        return new Transaction().add(ix);
      }, [], 200_000);
      onChange();
    } catch (e) {
      setError(friendlyError(e, copy.tooEarly));
    }
  };
  return (
    <Card title={copy.title} className="mt-6 unwind-card">
      {progress === null ? <p>{copy.checking}</p> : progress !== MigrationProgress.PreBondingCurve ? <p>{copy.graduatedInstead}</p> : ready ? <p>{copy.bodyReady}</p> : <p>{copy.bodyWaiting} <strong>{when}</strong>.</p>}
      <p className="caption mt-2">{copy.whatHappens}</p>
      {ready && status.state !== "done" && (
        <button type="button" className="button button-secondary mt-4" onClick={unwind} disabled={status.state === "sending"}>
          {status.state === "sending" ? "Sending…" : copy.action}
        </button>
      )}
      {status.state === "done" && (
        <p className="mt-3 text-sm">{copy.done} <a href={EXPLORER("tx", status.signature!)} target="_blank" rel="noreferrer" className="text-ion">↗</a></p>
      )}
      {(error || status.state === "error") && <p role="alert" className="form-error">{error ?? status.message}</p>}
    </Card>
  );
}
