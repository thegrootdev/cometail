"use client";
// A program's build verification record, signed by the upgrade authority: one instruction to the
// public verification program (the registry explorers read) that names the repository, the commit
// and the build arguments the on-chain bytes were built from. The instruction bytes were produced by
// the verifier tool from the public repository and are embedded here unchanged; the page decodes and
// shows them, derives the record address, reads the program's own hash from the chain and refuses
// to send unless that hash equals the reproducible build's. Nothing here is for users.
import { useCallback, useEffect, useState } from "react";
import { PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Shell, Card, ConnectWallet } from "@/components/Shell";
import { PageHeader } from "@/components/Experience";
import { CopyAddress } from "@/components/CopyAddress";
import { useTx } from "@/lib/hooks";
import { ADMIN, CLUSTER, EXPLORER } from "@/lib/addresses";

/** The public verification program and the record's seeds. */
const VERIFY_PROGRAM = new PublicKey("verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** What one program's page embeds: the instruction data the verifier tool exported for this program,
 *  repository and commit (hex, unchanged), the hash of the program bytes on chain when the page was written,
 *  and the hash of the reproducible build from the same commit in the verifiable-build container. Sending needs
 *  all three equal: the chain now, the expected value, and the reproducible build. */
export type VerifyRecordProps = { programId: PublicKey; programName: string; ixData: string; expectedOnchainHash: string; reproducibleBuildHash: string };

function decodeInput(hex: string) {
  const d = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  let i = 8;
  const str = () => { const n = d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24); i += 4; const s = new TextDecoder().decode(d.subarray(i, i + n)); i += n; return s; };
  const version = str(), repo = str(), commit = str();
  const count = d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24); i += 4;
  const args: string[] = []; for (let k = 0; k < count; k++) args.push(str());
  let slot = 0n; for (let k = 7; k >= 0; k--) slot = (slot << 8n) | BigInt(d[i + k]); i += 8;
  return { version, repo, commit, args, deploySlot: slot, bytes: d, consumed: i };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length); copy.set(bytes); // a plain buffer for the digest API
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function VerifyRecord({ programId, programName, ixData, expectedOnchainHash, reproducibleBuildHash }: VerifyRecordProps) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { run, status } = useTx();
  const input = decodeInput(ixData);
  const [authority, setAuthority] = useState<string | null | undefined>(undefined);
  const [deploySlot, setDeploySlot] = useState<bigint | undefined>(undefined);
  const [onChainHash, setOnChainHash] = useState<string | undefined>(undefined);
  const [recordExists, setRecordExists] = useState<boolean | undefined>(undefined);
  const [readError, setReadError] = useState("");
  const [simulation, setSimulation] = useState("");
  const admin = ADMIN;
  const isAuthority = !!publicKey && !!authority && publicKey.toBase58() === authority;
  const [record] = publicKey ? PublicKey.findProgramAddressSync([Buffer.from("otter_verify"), publicKey.toBuffer(), programId.toBuffer()], VERIFY_PROGRAM) : [null];

  const refresh = useCallback(async () => {
    setReadError("");
    try {
      const program = await connection.getAccountInfo(programId);
      if (!program || !program.owner.equals(LOADER) || program.data.length < 36) throw new Error("program account is not an upgradeable program");
      const programData = new PublicKey(program.data.subarray(4, 36));
      const info = await connection.getAccountInfo(programData);
      if (!info || info.data.length < 45 || info.data.readUInt32LE(0) !== 3) throw new Error("program data account unreadable");
      let slot = 0n; for (let k = 7; k >= 0; k--) slot = (slot << 8n) | BigInt(info.data[4 + k]);
      setDeploySlot(slot);
      setAuthority(info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)).toBase58() : null);
      // the hash the registry uses: the program bytes with trailing zeros stripped
      let end = info.data.length; while (end > 45 && info.data[end - 1] === 0) end--;
      setOnChainHash(await sha256Hex(info.data.subarray(45, end)));
      if (record) setRecordExists(!!(await connection.getAccountInfo(record)));
    } catch (e: any) { setReadError(String(e?.message ?? e)); setAuthority(undefined); setOnChainHash(undefined); }
  }, [connection, programId.toBase58(), record?.toBase58()]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setSimulation(""); }, [publicKey?.toBase58(), onChainHash, recordExists]);

  const build = useCallback(async () => {
    if (!publicKey || !record) throw new Error("connect the upgrade authority wallet");
    const ix = new TransactionInstruction({
      programId: VERIFY_PROGRAM,
      keys: [
        { pubkey: record, isSigner: false, isWritable: true },
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: programId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(input.bytes),
    });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), ix);
    tx.feePayer = publicKey;
    return tx;
  }, [publicKey?.toBase58(), programId.toBase58(), record?.toBase58()]);

  const simulate = async () => {
    try {
      const tx = await build();
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const res = await connection.simulateTransaction(tx);
      setSimulation(res.value.err ? `simulation FAILED: ${JSON.stringify(res.value.err)} ${(res.value.logs ?? []).filter((l) => /Error|failed/.test(l)).slice(-3).join(" | ")}` : `simulation OK: ${res.value.unitsConsumed ?? "?"} compute units`);
    } catch (e: any) { setSimulation(`simulation FAILED: ${String(e?.message ?? e)}`); }
  };
  const sign = async () => { const sig = await run(build, [], 100_000); if (sig) await refresh(); };

  const hashesMatch = !!onChainHash && onChainHash === expectedOnchainHash && reproducibleBuildHash === expectedOnchainHash;
  const slotMatches = deploySlot !== undefined && deploySlot === input.deploySlot;
  const ready = isAuthority && hashesMatch && slotMatches && recordExists === false && simulation.startsWith("simulation OK");

  return (
    <Shell>
      <PageHeader eyebrow="Admin" title={`Build verification: ${programName}`} body={`One signature from the upgrade authority on ${CLUSTER} records which public source the program was built from. Nothing here is for users.`} />
      <p className="text-sm">Program: <a href="/admin/verify">vault</a> · <a href="/admin/verify/burn">burn</a></p>
      <Card title="1. Wallet">
        <ConnectWallet />
        {publicKey && <p className="mt-2 text-sm [overflow-wrap:anywhere]">Connected {publicKey.toBase58()} {isAuthority ? "= upgrade authority" : authority ? `is NOT the upgrade authority ${authority}` : ""}</p>}
        {admin && authority && authority !== admin.toBase58() && <p className="mt-2 text-sm">The chain&apos;s upgrade authority differs from the site&apos;s admin address; the chain wins.</p>}
      </Card>
      <Card title="2. The program on chain">
        {readError && <p className="mb-2 text-sm">Could not read the chain: {readError} <button className="pill" onClick={() => refresh()}>Retry</button></p>}
        <ul className="text-sm space-y-1 [overflow-wrap:anywhere]">
          <li>program: <CopyAddress address={programId.toBase58()} label="Program" /></li>
          <li>upgrade authority: {authority === undefined ? "reading" : authority ?? "none (frozen)"}</li>
          <li>deployed at slot: {deploySlot === undefined ? "reading" : deploySlot.toString()} {deploySlot !== undefined && (slotMatches ? "= the record's slot" : `(the record names slot ${input.deploySlot.toString()}; a redeploy happened, re-export the record)`)}</li>
          <li>hash on chain now: <code className="break-all">{onChainHash ?? "reading"}</code></li>
          <li>hash when this page was written: <code className="break-all">{expectedOnchainHash}</code> {onChainHash && (onChainHash === expectedOnchainHash ? "= same bytes" : "DIFFERENT: the program changed")}</li>
          <li>reproducible build from the commit below: {reproducibleBuildHash ? <><code className="break-all">{reproducibleBuildHash}</code> {reproducibleBuildHash === expectedOnchainHash ? "= matches the chain" : "DOES NOT match the chain: verification would fail"}</> : "not run yet; this page will not send until it has run and matches"}</li>
          <li>verification record {record ? <CopyAddress address={record.toBase58()} label="Record" /> : "(connect the authority to derive it)"}: {recordExists === undefined ? "unknown" : recordExists ? "already exists" : "not written yet"}</li>
        </ul>
      </Card>
      <Card title="3. What the record will say">
        <ul className="text-sm space-y-1 [overflow-wrap:anywhere]">
          <li>repository: {input.repo}</li>
          <li>commit: <code className="break-all">{input.commit}</code></li>
          <li>build arguments: {input.args.join(" ")}</li>
          <li>deploy slot: {input.deploySlot.toString()}</li>
          <li>verifier version: {input.version}</li>
        </ul>
        <p className="mt-2 text-xs opacity-70">After the record is written, the public verifier rebuilds this commit from the repository and compares it with the chain. The record alone proves nothing; the rebuild does.</p>
      </Card>
      <Card title="4. Simulate, then sign">
        <div className="flex gap-2">
          <button className="pill" onClick={simulate} disabled={!isAuthority || !hashesMatch || !slotMatches || recordExists !== false}>Simulate</button>
          <button className="pill" onClick={sign} disabled={!ready || status.state === "sending"}>Sign the verification record with Phantom</button>
        </div>
        {!hashesMatch && <p className="mt-2 text-sm">Sending is blocked until the reproducible build&apos;s hash is recorded on this page and equals the chain.</p>}
        {simulation && <p className="mt-2 text-sm">{simulation}</p>}
        {status.state === "sending" && <p className="mt-2 text-sm">Waiting for the wallet and the confirmation.</p>}
        {status.state === "error" && <p className="mt-2 text-sm" role="alert">Failed: {status.message}</p>}
        {status.state === "error" && status.signature && <p className="mt-1 text-sm">The transaction was sent but its confirmation did not come back: check <a href={EXPLORER("tx", status.signature)} target="_blank" rel="noreferrer">{status.signature}</a> before trying again.</p>}
        {status.state === "done" && status.signature && <p className="mt-2 text-sm">Sent: <a href={EXPLORER("tx", status.signature)} target="_blank" rel="noreferrer">{status.signature}</a></p>}
      </Card>
    </Shell>
  );
}
