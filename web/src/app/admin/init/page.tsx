"use client";
// The one mainnet step that needs the admin wallet's signature: init_protocol. The program stores the
// signer as the protocol admin and requires that signer to be the program's upgrade authority, so this
// page only works for the admin wallet, after the deploy script has handed the upgrade authority over.
// It builds the instruction from the public addresses the site already carries, simulates it, shows
// every account for the owner to compare, sends it with the connected wallet (one signature, which also
// pays the protocol account's rent), then reads the protocol back and compares field by field.
import { useCallback, useEffect, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VaultClientStep6, VAULT_PROGRAM_ID } from "@cometail/client";
import { Shell, Card, ConnectWallet } from "@/components/Shell";
import { PageHeader } from "@/components/Experience";
import { CopyAddress } from "@/components/CopyAddress";
import { useTx } from "@/lib/hooks";
import { ADDRESSES, ADMIN, KEEPER, CLUSTER, EXPLORER } from "@/lib/addresses";

type Row = { what: string; expected: string; actual?: string; ok?: boolean };

export default function AdminInitPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { run, status } = useTx();
  const [protocol, setProtocol] = useState<any | null | undefined>(undefined);
  const [authority, setAuthority] = useState<string | null | undefined>(undefined);
  const [treasuryExists, setTreasuryExists] = useState<boolean | undefined>(undefined);
  const [simulation, setSimulation] = useState<string>("");
  const [rows, setRows] = useState<Row[]>([]);

  const client = new VaultClientStep6(connection);
  const admin = ADMIN;
  const treasury = admin ? getAssociatedTokenAddressSync(NATIVE_MINT, admin) : null;
  const streams = ADDRESSES.streamConfigs as [PublicKey, PublicKey, PublicKey];
  const isAdmin = !!publicKey && !!admin && publicKey.equals(admin);

  const expected: Row[] = admin && KEEPER && treasury ? [
    { what: "admin (your wallet, the upgrade authority)", expected: admin.toBase58() },
    { what: "keeper", expected: KEEPER.toBase58() },
    { what: "treasury (admin's WSOL account)", expected: treasury.toBase58() },
    { what: "stream-25 config", expected: streams[0].toBase58() },
    { what: "stream-50 config", expected: streams[1].toBase58() },
    { what: "stream-75 config", expected: streams[2].toBase58() },
    { what: "program", expected: VAULT_PROGRAM_ID.toBase58() },
  ] : [];

  const refresh = useCallback(async () => {
    const info = await connection.getAccountInfo(client.protocol);
    setProtocol(info ? client.decodeProtocol(info.data) : null);
    const data = await connection.getAccountInfo(client.programData);
    // ProgramData: 4 bytes kind, 8 bytes slot, 1 byte option, 32 bytes authority
    setAuthority(data && data.data.length >= 45 && data.data[12] === 1 ? new PublicKey(data.data.subarray(13, 45)).toBase58() : null);
    setTreasuryExists(treasury ? !!(await connection.getAccountInfo(treasury)) : false);
  }, [connection, treasury?.toBase58()]);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  useEffect(() => {
    if (!protocol || !admin || !KEEPER || !treasury) return;
    const actual = [protocol.admin, protocol.keeper, protocol.treasury, ...protocol.streamConfigs].map((k: PublicKey) => k.toBase58());
    setRows(expected.slice(0, 6).map((r, i) => ({ ...r, actual: actual[i], ok: actual[i] === r.expected })));
  }, [protocol]);

  const build = useCallback(async () => {
    if (!publicKey || !admin || !KEEPER || !treasury) throw new Error("addresses missing");
    const ix = await client.initProtocol({ admin: publicKey, keeper: KEEPER, payer: publicKey, treasury, streamConfigs: streams });
    const tx = new Transaction().add(ix);
    tx.feePayer = publicKey;
    return tx;
  }, [publicKey, admin?.toBase58(), KEEPER?.toBase58(), treasury?.toBase58()]);

  const simulate = async () => {
    try {
      const tx = await build();
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const res = await connection.simulateTransaction(tx);
      setSimulation(res.value.err ? `simulation FAILED: ${JSON.stringify(res.value.err)} ${(res.value.logs ?? []).filter((l) => /Error|failed/.test(l)).slice(-3).join(" | ")}` : `simulation OK: ${res.value.unitsConsumed ?? "?"} compute units; nothing was sent`);
    } catch (e: any) { setSimulation(`simulation FAILED: ${String(e?.message ?? e)}`); }
  };

  const sign = async () => {
    const sig = await run(build, [], 200_000);
    if (sig) await refresh();
  };

  const missing = !admin ? "NEXT_PUBLIC_ADMIN" : !KEEPER ? "NEXT_PUBLIC_KEEPER" : !treasury ? "treasury" : null;
  const ready = isAdmin && authority === admin?.toBase58() && treasuryExists === true && protocol === null && simulation.startsWith("simulation OK");

  return (
    <Shell>
      <PageHeader eyebrow="Admin" title="Protocol init" body={`One signature from the admin wallet on ${CLUSTER}. Nothing here is for users.`} />
      <Card title="1. Wallet">
        <ConnectWallet />
        {publicKey && (
          <p className="mt-2 text-sm">
            Connected {publicKey.toBase58()} {isAdmin ? "= admin wallet" : admin ? `is NOT the admin wallet ${admin.toBase58()}` : ""}
          </p>
        )}
        {missing && <p className="mt-2 text-sm">Missing site variable: {missing}.</p>}
      </Card>
      <Card title="2. Preconditions (read from the chain)">
        <ul className="text-sm space-y-1">
          <li>program upgrade authority: {authority === undefined ? "reading" : authority ?? "none"} {authority && admin && authority === admin.toBase58() ? "= admin wallet" : authority ? "(must be the admin wallet first: run the deploy script's handover)" : ""}</li>
          <li>treasury account {treasury?.toBase58()}: {treasuryExists === undefined ? "reading" : treasuryExists ? "exists" : "missing (the setup run creates it)"}</li>
          <li>protocol account {client.protocol.toBase58()}: {protocol === undefined ? "reading" : protocol === null ? "not initialized yet" : "already initialized"}</li>
        </ul>
      </Card>
      <Card title="3. What init_protocol will record">
        <ul className="text-sm space-y-1">
          {expected.map((r) => (<li key={r.what}><span className="opacity-70">{r.what}:</span> <CopyAddress address={r.expected} /></li>))}
        </ul>
        <p className="mt-2 text-xs opacity-70">Compare every address with the mainnet manifest before signing. The admin stored on chain is the signer: your wallet, never a box key.</p>
      </Card>
      {protocol === null && (
        <Card title="4. Simulate, then sign">
          <div className="flex gap-2">
            <button className="pill" onClick={simulate} disabled={!isAdmin}>Simulate</button>
            <button className="pill" onClick={sign} disabled={!ready || status.state === "sending"}>Sign init_protocol with Phantom</button>
          </div>
          {simulation && <p className="mt-2 text-sm">{simulation}</p>}
          {status.state === "sending" && <p className="mt-2 text-sm">Waiting for the wallet and the confirmation.</p>}
          {status.state === "error" && <p className="mt-2 text-sm">Failed: {status.message}</p>}
          {status.state === "done" && status.signature && <p className="mt-2 text-sm">Sent: <a href={EXPLORER("tx", status.signature)} target="_blank" rel="noreferrer">{status.signature}</a></p>}
        </Card>
      )}
      {protocol && (
        <Card title="Protocol on chain">
          <ul className="text-sm space-y-1">
            {rows.map((r) => (<li key={r.what}>{r.ok ? "PASS" : "FAIL"} {r.what}: {r.actual}{r.ok ? "" : ` (expected ${r.expected})`}</li>))}
            <li>paused routing: {String(protocol.pausedRouting)}</li>
          </ul>
        </Card>
      )}
    </Shell>
  );
}
