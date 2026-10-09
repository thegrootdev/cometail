"use client";
// Tails, run by hand from the owner's wallet. A tail is a coin launched by this wallet on the Take 50% fee-sale
// config and pointed at $COMETAIL. No program of ours is involved: every claim of the tail's creator fees is
// split in the same transaction you sign here (half stays in your wallet, a quarter goes to the burn reserve, a
// quarter becomes $COMETAIL liquidity in your own position, permanently locked). The split is ours, done in the
// open; the site lists every claim with its transaction. Nothing here is for users.
import { useCallback, useEffect, useState } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Shell, Card, ConnectWallet } from "@/components/Shell";
import { PageHeader, StorageNotice } from "@/components/Experience";
import { CopyAddress } from "@/components/CopyAddress";
import { LogoUpload, type TokenImage } from "@/components/TokenIdentity";
import { useStorageReady, useTx } from "@/lib/hooks";
import { launchTx } from "@/lib/dbc";
import { uploadIdentity } from "@/lib/upload";
import { cleanSymbolInput } from "@/lib/token-display";
import { api, type TailInfo } from "@/lib/api";
import { COMETAIL_POOL, EXPLORER, OFFICIAL_MINT } from "@/lib/addresses";
import { TAIL_CONFIG, cashoutTx, claimTx, graduatedClaimTx, lockedPositionTx, readTail, type TailChain } from "@/lib/tails";
import { tailSplit } from "@cometail/client";

const sol = (l: bigint) => `${(Number(l) / 1e9).toFixed(6)} SOL`;

export default function AdminTailsPage() {
  const { connection } = useConnection();
  const { publicKey, signMessage } = useWallet();
  const { run, status } = useTx();
  const storage = useStorageReady();
  const [known, setKnown] = useState<TailInfo[]>([]);
  const [mintText, setMintText] = useState("");
  const [tail, setTail] = useState<TailChain | null>(null);
  const [readError, setReadError] = useState("");
  const [note, setNote] = useState("");
  const [simulation, setSimulation] = useState("");
  const [chosen, setChosen] = useState<string>("");
  // launch form
  const [name, setName] = useState(""), [symbol, setSymbol] = useState(""), [description, setDescription] = useState("");
  const [image, setImage] = useState<TokenImage | null>(null);

  useEffect(() => { void api.tailList().then((r) => { if (r?.tails) { setKnown(r.tails); if (r.tails[0] && !mintText) setMintText(r.tails[0].mint); } }); }, []);
  const mint = (() => { try { return mintText.trim() ? new PublicKey(mintText.trim()) : null; } catch { return null; } })();
  const configured = known.find((t) => t.mint === mint?.toBase58()) ?? null;

  const refresh = useCallback(async () => {
    setReadError(""); setSimulation("");
    if (!publicKey || !mint) { setTail(null); return; }
    try {
      const t = await readTail(connection, publicKey, mint);
      setTail(t);
      // the worker's configured position first, else the only locked one this wallet holds in the pool
      const pick = t.positions.find((p) => configured?.positions.includes(p.position.toBase58())) ?? (t.positions.length === 1 ? t.positions[0] : null);
      setChosen(pick?.position.toBase58() ?? "");
    } catch (e: any) { setReadError(String(e?.message ?? e)); setTail(null); }
  }, [connection, publicKey?.toBase58(), mint?.toBase58(), configured?.positions.join(",")]);
  useEffect(() => { void refresh(); }, [refresh]);

  const launch = async () => {
    if (!publicKey || !signMessage || !image?.file || !name.trim() || !symbol.trim()) return;
    setNote("");
    try {
      const { uri } = await uploadIdentity({ name: name.trim(), symbol: cleanSymbolInput(symbol), description, links: {}, image: image.file, owner: publicKey, signMessage });
      const kp = Keypair.generate();
      const sig = await run(() => launchTx(connection, { config: TAIL_CONFIG, payer: publicKey, baseMint: kp.publicKey, name: name.trim(), symbol: cleanSymbolInput(symbol), uri }), [kp]);
      if (sig) { setMintText(kp.publicKey.toBase58()); setNote(`Launched ${kp.publicKey.toBase58()}.`); }
    } catch (e: any) { setNote(`Launch failed: ${String(e?.message ?? e)}`); }
  };

  const position = tail?.positions.find((p) => p.position.toBase58() === chosen) ?? null;
  const createPosition = async () => {
    if (!publicKey || !mint || !tail?.target) return;
    const nft = Keypair.generate();
    const { tx, position: p } = lockedPositionTx(publicKey, nft.publicKey, mint, tail.target);
    const sig = await run(async () => tx, [nft], 200_000);
    if (sig) { setNote(`Locked position created: ${p.toBase58()}.`); await refresh(); }
  };
  const simulateClaim = async () => {
    if (!publicKey || !mint || !tail || !position) return;
    try {
      const { tx } = claimTx(publicKey, mint, tail, position);
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const r = await connection.simulateTransaction(tx);
      setSimulation(r.value.err ? `simulation FAILED: ${JSON.stringify(r.value.err)} ${(r.value.logs ?? []).filter((l) => /Error|failed/.test(l)).slice(-3).join(" | ")}` : `simulation OK: ${r.value.unitsConsumed ?? "?"} compute units`);
    } catch (e: any) { setSimulation(`simulation FAILED: ${String(e?.message ?? e)}`); }
  };
  const claim = async () => {
    if (!publicKey || !mint || !tail || !position) return;
    // built from a fresh read: a claim built from stale state would fail as a whole and move nothing
    const sig = await run(async () => claimTx(publicKey, mint, await readTail(connection, publicKey, mint), position).tx, [], 400_000);
    if (sig) await refresh();
  };
  const cashout = async () => { if (publicKey && mint && tail) { const sig = await run(async () => cashoutTx(publicKey, mint, tail), [], 200_000); if (sig) await refresh(); } };
  const graduatedClaim = async () => { if (publicKey && mint && tail) { const sig = await run(() => graduatedClaimTx(connection, publicKey, mint, tail), [], 400_000); if (sig) await refresh(); } };

  const split = tail ? tailSplit(tail.claimable) : null;
  const workerLine = mint ? `${mint.toBase58()}:${TAIL_CONFIG.toBase58()}:${COMETAIL_POOL?.toBase58() ?? "<$COMETAIL pool>"}` : "";

  return (
    <Shell>
      <PageHeader eyebrow="Admin" title="Tails" body="A tail is a coin you launch from your own wallet on the Take 50% config and point at $COMETAIL. Every claim of its creator fees is split here, in one transaction you sign: half stays in your wallet, a quarter goes to the $COMETAIL burn, a quarter becomes $COMETAIL liquidity locked forever in your position. The split is done by us, in the open; no program forces it." />
      <Card title="1. Wallet">
        <ConnectWallet />
        {publicKey && <p className="mt-2 text-sm [overflow-wrap:anywhere]">Connected {publicKey.toBase58()}</p>}
      </Card>

      <Card title="2. Launch a tail">
        <p className="text-sm">On the Take 50% config (<code className="break-all">{TAIL_CONFIG.toBase58()}</code>), with this wallet as the creator: at graduation 50% of the raise comes to this wallet and the rest is locked as liquidity. No deposit.</p>
        <StorageNotice storage={storage} />
        <fieldset disabled={!publicKey || status.state === "sending" || (storage.checked && !storage.ready)} className="mt-2 space-y-2">
          <LogoUpload onChange={setImage} />
          <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="tail of COMETAIL" /></label>
          <label className="field"><span>Ticker</span><input value={symbol} onChange={(e) => setSymbol(cleanSymbolInput(e.target.value))} placeholder="tCOMETAIL" /></label>
          <label className="field"><span>Description</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          <button className="button button-primary button-full" onClick={launch} disabled={!image?.file || !name.trim() || !symbol.trim()}>Launch the tail</button>
        </fieldset>
      </Card>

      <Card title="3. A tail">
        <label className="field"><span>Tail mint</span><input value={mintText} onChange={(e) => setMintText(e.target.value)} placeholder="the tail's mint address" /></label>
        {known.length > 0 && <p className="mt-1 text-xs opacity-70">Tails the worker records: {known.map((t) => t.mint.slice(0, 6) + "…").join(", ")}</p>}
        {readError && <p className="mt-2 text-sm">Could not read the chain: {readError} <button className="pill" onClick={() => refresh()}>Retry</button></p>}
        {tail && (
          <ul className="mt-2 text-sm space-y-1 [overflow-wrap:anywhere]">
            <li>curve: {tail.state ? <CopyAddress address={tail.curve.toBase58()} label="Curve" /> : "not found on the Take 50% config"}</li>
            {tail.state && <li>stage: {tail.stage === "curve" ? "on its curve" : tail.stage === "complete" ? "curve complete, migrating" : "graduated"}</li>}
            {tail.state && <li>creator: {tail.isCreator ? "this wallet" : `NOT this wallet (${String(tail.state.creator)})`}</li>}
            <li>target: $COMETAIL pool {tail.target ? "readable, compounding, constant fee" : `unusable: ${tail.targetError}`}</li>
            <li>worker setting: <code className="break-all">COMETAIL_TAILS={workerLine}</code></li>
          </ul>
        )}
      </Card>

      {tail?.state && tail.isCreator && (
        <Card title="4. Your locked $COMETAIL position">
          {tail.positions.length === 0 && <><p className="text-sm">You have no position in the $COMETAIL pool yet. Create it once; every claim adds to it and locks what it adds.</p>
            <button className="button button-full mt-2" onClick={createPosition} disabled={!tail.target || status.state === "sending"}>Create the locked position</button></>}
          {tail.positions.length > 0 && (
            <ul className="text-sm space-y-1 [overflow-wrap:anywhere]">
              {tail.positions.map((p) => (
                <li key={p.position.toBase58()}><label><input type="radio" name="pos" checked={chosen === p.position.toBase58()} onChange={() => setChosen(p.position.toBase58())} /> {p.position.toBase58()} · locked {p.locked.toString()} · unlocked {p.unlocked.toString()}</label></li>
              ))}
            </ul>
          )}
          {tail.positions.length > 0 && <p className="mt-2 text-sm">Claims add to this position and lock exactly what they add. The tail page counts only that, not what the position already held.</p>}
          {tail.positions.length > 1 && !configured?.positions.length && <p className="mt-2 text-sm">More than one position in this pool: choose the one this tail&apos;s claims should add to.</p>}
        </Card>
      )}

      {tail?.state && tail.isCreator && split && (
        <Card title="5. Claim and split">
          <ul className="text-sm space-y-1">
            <li>creator fees waiting: {sol(tail.claimable)}</li>
            <li>stays in your wallet: {sol(split.kept)}</li>
            <li>to the $COMETAIL burn reserve: {sol(split.toBurn)}</li>
            <li>to $COMETAIL liquidity, locked: {sol(split.toLiquidity)} (part of it is swapped to $COMETAIL first, sized so both sides add fully)</li>
          </ul>
          <div className="flex gap-2 mt-2">
            <button className="pill" onClick={simulateClaim} disabled={!position || !tail.target || split.toLiquidity < 1_000n}>Simulate</button>
            <button className="button button-gold" onClick={claim} disabled={!position || !tail.target || !simulation.startsWith("simulation OK") || status.state === "sending"}>Claim and split</button>
          </div>
          {!position && <p className="mt-2 text-sm">Create or choose the locked position first.</p>}
          {simulation && <p className="mt-2 text-sm">{simulation}</p>}
        </Card>
      )}

      {tail?.state && tail.isCreator && tail.stage !== "curve" && (
        <Card title="6. After graduation">
          <p className="text-sm">The graduation payout (the creator&apos;s migration fee and surplus) comes to this wallet in full. The graduated pool&apos;s position fees go through the burn program&apos;s owner claim: half to the burn reserve, half to this wallet.</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <button className="button" onClick={cashout} disabled={!(tail.migrationFeePending || tail.surplusPending) || status.state === "sending"}>{tail.migrationFeePending || tail.surplusPending ? "Collect the graduation payout" : "Graduation payout collected"}</button>
            <button className="button" onClick={graduatedClaim} disabled={!tail.graduated || tail.graduated.pendingLamports === 0n || status.state === "sending"}>Claim the graduated pool&apos;s fees{tail.graduated ? ` (${sol(tail.graduated.pendingLamports)})` : ""}</button>
          </div>
        </Card>
      )}

      {note && <p className="mt-2 text-sm [overflow-wrap:anywhere]">{note}</p>}
      {status.state === "error" && <p className="mt-2 text-sm" role="alert">Failed: {status.message}</p>}
      {status.state === "error" && status.signature && <p className="mt-1 text-sm">Sent but the confirmation did not come back: check <a href={EXPLORER("tx", status.signature)} target="_blank" rel="noreferrer">{status.signature}</a> before trying again.</p>}
      {status.state === "done" && status.signature && <p className="mt-2 text-sm [overflow-wrap:anywhere]">Sent: <a href={EXPLORER("tx", status.signature)} target="_blank" rel="noreferrer">{status.signature}</a></p>}
      {!OFFICIAL_MINT && <p className="mt-2 text-sm">The site has no NEXT_PUBLIC_OFFICIAL_MINT: the target is unknown.</p>}
    </Shell>
  );
}
