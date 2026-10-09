"use client";
// Tails, run by hand from the owner's wallet. A tail is a coin launched by this wallet on the Take 50% fee-sale
// config and pointed at $COMETAIL. No program of ours is involved: every claim of the tail's creator fees is
// split in the same transaction you sign here (half stays in your wallet, a quarter goes to the burn reserve, a
// quarter becomes $COMETAIL liquidity in your own position, permanently locked). The split is ours, done in the
// open; the site lists every claim with its transaction. Nothing here is for users.
import { useCallback, useEffect, useRef, useState } from "react";
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
import { api, type TailClaim, type TailInfo } from "@/lib/api";
import { COMETAIL_POOL, EXPLORER, OFFICIAL_MINT } from "@/lib/addresses";
import { recordSigned, releaseUnsigned, reserve, settle, stillReserved, type ReservationState } from "@/lib/makeup-reservation";
import { TAIL_CONFIG, cashoutTx, claimTx, graduatedClaimTx, lockedPositionTx, makeUpBlocked, makeUpOnChain, makeUpTx, readTail, type TailChain } from "@/lib/tails";
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
  // the worker's record of this tail, for make-ups, kept with the mint it was read for: null while unread
  const [record, setRecord] = useState<{ mint: string; info: TailInfo | null } | null>(null);
  const recordRead = useRef(0);
  const [makeUpFor, setMakeUpFor] = useState("");
  // a simulation is only good for the exact tail, claim, position and wallet it ran for
  const [makeUpSim, setMakeUpSim] = useState<{ key: string; text: string } | null>(null);
  // claims a make-up was started for in this page: set before anything is awaited; cleared only when the
  // reservation shows nothing was signed
  const makeUpStarted = useRef(new Set<string>());
  // this browser's reservation for the selected claim, read through the shared lock and settled against the chain
  const [resv, setResv] = useState<{ key: string; state: ReservationState | null; error?: string } | null>(null);
  // launch form
  const [name, setName] = useState(""), [symbol, setSymbol] = useState(""), [description, setDescription] = useState("");
  const [image, setImage] = useState<TokenImage | null>(null);

  useEffect(() => { void api.tailList().then((r) => { if (r?.tails) { setKnown(r.tails); if (r.tails[0] && !mintText) setMintText(r.tails[0].mint); } }); }, []);
  const mint = (() => { try { return mintText.trim() ? new PublicKey(mintText.trim()) : null; } catch { return null; } })();
  const configured = known.find((t) => t.mint === mint?.toBase58()) ?? null;

  const refresh = useCallback(async () => {
    setReadError(""); setSimulation(""); setMakeUpSim(null); setRecord(null);
    if (mint) {
      const ask = ++recordRead.current, m = mint.toBase58();
      void api.tail(m).then((r) => { if (ask === recordRead.current) setRecord({ mint: m, info: r.state === "ok" ? r.tail : null }); });
    }
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
  // make-ups: once per claim, ever. Offered only from this tail's own record by a worker that records make-ups and
  // has read the whole history; checked again at send against a fresh record, the wallet's own history since the
  // claim (a make-up that landed shows there before the worker reads it), a pending send from this browser, and a
  // lock taken before anything is awaited.
  const mintStr = mint?.toBase58() ?? "";
  const rec = record && record.mint === mintStr ? record.info : null;
  const owed: TailClaim[] = rec ? rec.claims.filter((c) => c.source === "curve" && makeUpBlocked(rec, mintStr, c) === null) : [];
  const owedClaim = owed.find((c) => c.signature === makeUpFor) ?? owed[0] ?? null;
  const simKey = owedClaim && position && publicKey ? `${mintStr}|${owedClaim.signature}|${owedClaim.claimedLamports}|${position.position.toBase58()}|${publicKey.toBase58()}` : "";
  const resvKey = owedClaim ? `${mintStr}|${owedClaim.signature}` : "";
  const settleNow = useCallback(async () => {
    if (!mint || !owedClaim) return;
    const k = `${mint.toBase58()}|${owedClaim.signature}`;
    try { setResv({ key: k, state: await settle(connection, mint.toBase58(), owedClaim.signature) }); }
    catch (e: any) { setResv({ key: k, state: null, error: String(e?.message ?? e) }); }
  }, [connection, mint?.toBase58(), owedClaim?.signature]);
  useEffect(() => { void settleNow(); }, [settleNow]);
  const resvNow = resv && resv.key === resvKey ? resv : null;
  /** Why this claim cannot be made up right now, read fresh (null: it can). */
  const makeUpCheck = async (claim: TailClaim, holdingLock = false): Promise<string | null> => {
    if (!publicKey || !mint) return "connect the creator wallet";
    if (!holdingLock && makeUpStarted.current.has(`${mintStr}:${claim.signature}`)) return "a make-up of this claim was already started from this page";
    const fresh = await api.tail(mintStr);
    const blocked = makeUpBlocked(fresh.state === "ok" ? fresh.tail : null, mintStr, claim);
    if (blocked) return blocked;
    try {
      const landed = await makeUpOnChain(connection, publicKey, mint, claim.signature);
      if (landed) return `a make-up of this claim already landed: ${landed}`;
    } catch (e: any) { return `could not read this wallet's history to rule out an earlier make-up: ${String(e?.message ?? e)}`; }
    return null;
  };
  const simulateMakeUp = async () => {
    if (!publicKey || !mint || !tail || !position || !owedClaim) return;
    const key = simKey;
    setMakeUpSim({ key, text: "checking…" });
    const st = await settle(connection, mintStr, owedClaim.signature).catch((e: any) => ({ kind: "unknown", reason: String(e?.message ?? e) }) as const);
    if (st.kind !== "none") { setMakeUpSim({ key, text: "not possible: this browser holds a reservation or a make-up for this claim (see above)" }); await settleNow(); return; }
    const blocked = await makeUpCheck(owedClaim);
    if (blocked) { setMakeUpSim({ key, text: `not possible: ${blocked}` }); return; }
    try {
      const { tx } = makeUpTx(publicKey, mint, tail, owedClaim, position);
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const r = await connection.simulateTransaction(tx);
      setMakeUpSim({ key, text: r.value.err ? `simulation FAILED: ${JSON.stringify(r.value.err)} ${(r.value.logs ?? []).filter((l) => /Error|failed|insufficient/i.test(l)).slice(-3).join(" | ")}` : `simulation OK: ${r.value.unitsConsumed ?? "?"} compute units` });
    } catch (e: any) { setMakeUpSim({ key, text: `simulation FAILED: ${String(e?.message ?? e)}` }); }
  };
  const makeUp = async () => {
    if (!publicKey || !mint || !position || !owedClaim || makeUpSim?.key !== simKey) return;
    const claim = owedClaim, lock = `${mintStr}:${claim.signature}`;
    if (makeUpStarted.current.has(lock)) return;
    makeUpStarted.current.add(lock); // synchronously, before the first await: a second press in this page finds it
    const say = (text: string) => setMakeUpSim({ key: simKey, text });
    // the shared reservation, before anything is read over the network: a second tab finds it
    let id: string, held;
    try { id = crypto.randomUUID(); held = await reserve(mintStr, claim.signature, id); }
    catch (e: any) { makeUpStarted.current.delete(lock); say(`not sent: ${String(e?.message ?? e)}`); return; }
    if (held) { makeUpStarted.current.delete(lock); say("not sent: this browser already holds a reservation or a make-up for this claim (see above)"); await settleNow(); return; }
    const blocked = await makeUpCheck(claim, true);
    if (blocked) {
      if (await releaseUnsigned(mintStr, claim.signature, id).catch(() => false)) makeUpStarted.current.delete(lock);
      say(`not sent: ${blocked}`); await settleNow(); return;
    }
    const sig = await run(async () => makeUpTx(publicKey, mint, await readTail(connection, publicKey, mint), claim, position).tx, [], 400_000, {
      beforeSign: () => stillReserved(mintStr, claim.signature, id),
      afterSign: (signed) => recordSigned(mintStr, claim.signature, id, signed),
    });
    // never signed under the reservation (a failed dry run, the wallet declined, the reservation lost): released here
    const unsigned = await releaseUnsigned(mintStr, claim.signature, id).catch(() => false);
    if (unsigned) makeUpStarted.current.delete(lock);
    if (sig) setNote(`Make-up sent: ${sig}. The tail page shows it once the worker has read it (about a minute).`);
    else if (unsigned) setNote("The make-up was not signed, so nothing was sent. You can simulate and try again.");
    else setNote("The make-up was signed but its confirmation did not come back here. Do not send another: this page reads its outcome from the chain and keeps the claim blocked until it has landed, or failed or expired without landing.");
    await refresh(); await settleNow();
  };
  const releaseStuck = async () => {
    if (!mint || !owedClaim || resvNow?.state?.kind !== "reserved") return;
    await releaseUnsigned(mintStr, owedClaim.signature, resvNow.state.r.id).catch(() => false);
    await settleNow();
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

      {tail?.state && tail.isCreator && (
        <Card title="Make up a claim that was not split">
          <p className="text-sm">For a claim of this tail&apos;s curve fees made without the split. One transaction you sign sends, from this wallet&apos;s SOL, what the split would have: a quarter of the claim to the burn reserve and a quarter as liquidity locked in the position above. A memo names the tail and the claim, and the tail page then shows the claim as made up, with this transaction. Once per claim: the page checks this wallet&apos;s own history for an earlier make-up before it sends.</p>
          {(!record || record.mint !== mintStr) && <p className="mt-2 text-sm">Reading the worker&apos;s record…</p>}
          {record && record.mint === mintStr && !rec && <p className="mt-2 text-sm">The worker&apos;s record of this tail is unreadable: no make-up can be checked. <button className="pill" onClick={() => refresh()}>Retry</button></p>}
          {rec && !Array.isArray(rec.makeUps) && <p className="mt-2 text-sm">The worker does not record make-ups yet (restart it on this release first): a make-up sent now would never show.</p>}
          {rec && Array.isArray(rec.makeUps) && rec.coverage.claims.status !== "complete" && <p className="mt-2 text-sm">The worker has not finished reading this tail&apos;s history: wait for it.</p>}
          {rec && Array.isArray(rec.makeUps) && rec.coverage.claims.status === "complete" && owed.length === 0 && <p className="mt-2 text-sm">No curve claim is waiting for a make-up.</p>}
          {owed.length > 0 && owedClaim && (() => {
            const q = tailSplit(BigInt(owedClaim.claimedLamports));
            const sim = makeUpSim && makeUpSim.key === simKey ? makeUpSim.text : "";
            const st = resvNow?.state ?? null, free = st?.kind === "none";
            return (<>
              {owed.length > 1 && <ul className="mt-2 text-sm space-y-1 [overflow-wrap:anywhere]">{owed.map((c) => <li key={c.signature}><label><input type="radio" name="makeup" checked={owedClaim.signature === c.signature} onChange={() => { setMakeUpFor(c.signature); setMakeUpSim(null); }} /> {c.signature.slice(0, 10)}… · {sol(BigInt(c.claimedLamports))}</label></li>)}</ul>}
              <ul className="mt-2 text-sm space-y-1 [overflow-wrap:anywhere]">
                <li>claim: <a href={EXPLORER("tx", owedClaim.signature)} target="_blank" rel="noreferrer">{owedClaim.signature}</a>{owedClaim.blockTime ? ` (${new Date(owedClaim.blockTime * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}</li>
                <li>claimed, all kept: {sol(q.claimed)}</li>
                <li>to the $COMETAIL burn reserve: {sol(q.toBurn)}</li>
                <li>to $COMETAIL liquidity, locked: {sol(q.toLiquidity)}</li>
                <li>from this wallet in all: {sol(q.toBurn + q.toLiquidity)}, plus the network fee</li>
              </ul>
              {!resvNow && <p className="mt-2 text-sm">Reading this browser&apos;s make-up reservation…</p>}
              {resvNow && !st && <p className="mt-2 text-sm">This browser cannot hold a make-up reservation ({resvNow.error}): no make-up is sent from it.</p>}
              {st?.kind === "reserved" && <p className="mt-2 text-sm">A page in this browser reserved this make-up {new Date(st.r.at).toISOString().slice(11, 19)} UTC and has not signed it. If no other tab or window is making it up now, release it. A page whose reservation is released stops before it signs or sends. <button className="pill" onClick={releaseStuck}>Release the reservation</button></p>}
              {st?.kind === "pending" && <p className="mt-2 text-sm [overflow-wrap:anywhere]">A make-up of this claim was signed ({st.r.signature}) and may still land. Nothing else is sent until it lands, or fails or expires without landing. <button className="pill" onClick={() => settleNow()}>Check again</button></p>}
              {st?.kind === "landed" && <p className="mt-2 text-sm [overflow-wrap:anywhere]">The make-up of this claim landed: <a href={EXPLORER("tx", st.r.signature!)} target="_blank" rel="noreferrer">{st.r.signature}</a>. The tail page shows it once the worker has read it.</p>}
              {st?.kind === "unknown" && <p className="mt-2 text-sm">This browser&apos;s make-up for this claim could not be read from the chain ({st.reason}): nothing else is sent. <button className="pill" onClick={() => settleNow()}>Check again</button></p>}
              <div className="flex gap-2 mt-2">
                <button className="pill" onClick={simulateMakeUp} disabled={!position || !tail.target || !free}>Simulate</button>
                <button className="button button-gold" onClick={makeUp} disabled={!position || !tail.target || !free || !sim.startsWith("simulation OK") || status.state === "sending"}>Make up this claim</button>
              </div>
              {!position && <p className="mt-2 text-sm">Choose the locked position first.</p>}
              {sim && <p className="mt-2 text-sm">{sim}</p>}
            </>);
          })()}
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
