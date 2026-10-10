"use client";
import { friendlyError, insufficientSol, insufficientTokens, LAUNCH_OVERHEAD_LAMPORTS } from "@/lib/errors";
import { LaunchPresets } from "@/components/LaunchPresets";
import { LAUNCH_PRESETS, type LaunchPresetId } from "@/lib/launch-presets";
import { useEffect, useState } from "react";
import { CopyAddress } from "@/components/CopyAddress";
import Link from "next/link";
import { Keypair, Transaction } from "@solana/web3.js";
import { cometailForSol } from "@/lib/paired";
import { launchSolNeed, pendingFirstBuy } from "@/lib/launch-pending";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { Shell, ConnectWallet } from "@/components/Shell";
import { StorageNotice } from "@/components/Experience";
import {
  LogoUpload,
  IdentityPreview,
  type TokenImage,
} from "@/components/TokenIdentity";
import { plainLaunch, amounts, experience as c, launchSimple as launchCopy, paired as pairedCopy } from "@/content/cometail";
import { presetsPage } from "@/content/presets";
import { launchTx } from "@/lib/dbc";
import { uploadIdentity } from "@/lib/upload";
import { SocialFields } from "@/components/SocialLinks";
import { AmountInput } from "@/components/AmountInput";
import { readTokenBalance, useTokenBalance, useSolBalance } from "@/lib/balances";
import { formatAmount, inputValue, parseAmount, spendable } from "@/lib/amounts";
import { cleanLinks, linksValid, type TokenLinks, cleanSymbolInput } from "@/lib/token-display";
import { useTx , useStorageReady } from "@/lib/hooks";
import { CLUSTER, EXPLORER } from "@/lib/addresses";

export default function LaunchPage() {
  const { connection } = useConnection();
  const { signMessage } = useWallet();
  const { run, status, connected, publicKey } = useTx();
  const [presetId, setPresetId] = useState<LaunchPresetId>("standard");
  // the presets page links here with ?preset=<id>; an unknown or unavailable id keeps Standard
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("preset");
    const found = LAUNCH_PRESETS.find((p) => p.id === wanted && p.config);
    if (found) setPresetId(found.id);
  }, []);
  const preset = LAUNCH_PRESETS.find(p => p.id === presetId)!;
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [links, setLinks] = useState<TokenLinks>({});
  const [image, setImage] = useState<TokenImage | null>(null);
  const [firstBuy, setFirstBuy] = useState("");
  const [mint, setMint] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a paired launch with a first buy: the $COMETAIL bought in step 1, bound to the wallet, the config and the SOL amount
  // it was bought for; a retry of step 2 with the same three spends it without buying again
  const [bought, setBought] = useState<{ owner: string; config: string; solRaw: string; cometail: BN } | null>(null);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const storage = useStorageReady();
  const blocked = storage.checked && !storage.ready;
  const solBalance = useSolBalance(publicKey);
  const quoteBalance = useTokenBalance(preset.native ? null : preset.quoteMint, publicKey);
  // a paired preset's first buy is typed and paid in SOL; the other presets in their quote
  const quoteDecimals = preset.paidInSol ? 9 : preset.quote.decimals ?? 9;
  const quoteTicker = preset.paidInSol ? "SOL" : preset.quote.symbol;
  const buyBalance = preset.paidInSol ? solBalance.lamports : quoteBalance.raw;
  // the typed first buy in quote base units: 0n when empty, null when malformed
  const firstBuyRaw = firstBuy.trim() ? parseAmount(firstBuy, quoteDecimals) : 0n;
  const pending = preset.id === "paired" ? pendingFirstBuy(bought, publicKey?.toBase58() ?? null, preset.config?.toBase58() ?? null, firstBuyRaw) : null;
  // with the first buy's $COMETAIL already bought, the launch needs only its own costs in SOL
  const need = launchSolNeed(preset.paidInSol, firstBuyRaw, !!pending, LAUNCH_OVERHEAD_LAMPORTS);
  // the shortfall is said at the field, before anything is signed
  const shortfall = publicKey && firstBuyRaw !== null && solBalance.lamports !== null && solBalance.lamports < need ? insufficientSol(need, solBalance.lamports) : publicKey && !preset.paidInSol && firstBuyRaw !== null && buyBalance !== null && buyBalance < firstBuyRaw ? insufficientTokens(formatAmount(firstBuyRaw, quoteDecimals, { ticker: quoteTicker }), formatAmount(buyBalance, quoteDecimals, { ticker: quoteTicker })) : null;
  const quickBuys = [...["0.1", "0.5", "1"].map((v) => ({ label: `${v} ${quoteTicker}`, value: v })), { label: amounts.max, value: buyBalance === null ? null : inputValue(preset.paidInSol ? spendable(buyBalance, LAUNCH_OVERHEAD_LAMPORTS) ?? 0n : buyBalance, quoteDecimals) }];
  const valid =
    !!preset.config &&
    linksValid(links) &&
    firstBuyRaw !== null &&
    !shortfall &&
    !!image &&
    new TextEncoder().encode(name.trim()).length > 0 &&
    new TextEncoder().encode(name.trim()).length <= 32 &&
    new TextEncoder().encode(cleanSymbolInput(symbol)).length > 0 &&
    new TextEncoder().encode(cleanSymbolInput(symbol)).length <= 10;
  const busy = preparing || status.state === "sending";
  const submit = async () => {
    if (!valid || !image || !publicKey || !preset.config || busy || blocked) return;
    setPreparing(true);
    setError(null);
    try {
      const lamports = firstBuyRaw && firstBuyRaw > 0n ? new BN(firstBuyRaw.toString()) : undefined;
      // the launch pays the first buy, the 0.01 SOL creation fee, the mint and metadata rent and the
      // network fees (about 0.035 SOL): the wallet must hold that before anything is signed
      {
        const need = launchSolNeed(preset.paidInSol, lamports ? BigInt(lamports.toString()) : null, !!pending, LAUNCH_OVERHEAD_LAMPORTS);
        const have = BigInt(await connection.getBalance(publicKey));
        if (have < need) { setError(insufficientSol(need, have)); return; }
      }
      if (!preset.paidInSol && firstBuyRaw && preset.quoteMint) {
        const have = await readTokenBalance(connection, preset.quoteMint, publicKey);
        if (have < firstBuyRaw) { setError(insufficientTokens(formatAmount(firstBuyRaw, quoteDecimals, { ticker: quoteTicker }), formatAmount(have, quoteDecimals, { ticker: quoteTicker }))); return; }
      }
      const { uri } = await uploadIdentity({
        name,
        symbol: cleanSymbolInput(symbol),
        description,
        links: cleanLinks(links),
        image: image.file,
        owner: publicKey,
        signMessage,
      });
      // paired: the first buy's $COMETAIL is bought first (one transaction), then the coin is created with exactly that buy
      let firstBuyQuote = lamports, holdsCometail = false;
      if (preset.id === "paired" && lamports) {
        let amount = pending?.cometail ?? null;
        if (!amount) {
          setStep(1);
          let out: BN | null = null;
          const before = await readTokenBalance(connection, preset.quoteMint!, publicKey);
          const sig1 = await run(async () => { const r = await cometailForSol(connection, publicKey, lamports); out = r.cometail; return new Transaction().add(...r.instructions); }, [], 300_000);
          if (!out) return;
          // a confirmation that did not come back: the wallet's balance says whether the purchase landed
          if (!sig1 && (await readTokenBalance(connection, preset.quoteMint!, publicKey)) - before < BigInt((out as BN).toString())) return;
          amount = out;
          setBought({ owner: publicKey.toBase58(), config: preset.config!.toBase58(), solRaw: lamports.toString(), cometail: out });
        }
        const have = await readTokenBalance(connection, preset.quoteMint!, publicKey);
        if (have < BigInt(amount.toString())) { setBought(null); setError(insufficientTokens(formatAmount(BigInt(amount.toString()), 6, { ticker: "$COMETAIL" }), formatAmount(have, 6, { ticker: "$COMETAIL" }))); return; }
        firstBuyQuote = amount; holdsCometail = true;
        setStep(2);
      }
      const kp = Keypair.generate();
      const sig = await run(
        () =>
          launchTx(connection, {
            config: preset.config!,
            payer: publicKey,
            baseMint: kp.publicKey,
            name: name.trim(),
            symbol: cleanSymbolInput(symbol),
            uri,
            firstBuyRaw: firstBuyQuote,
            quoteMint: preset.quoteMint!,
            quoteDecimals: preset.quote.decimals ?? 9,
          }),
        [kp],
      );
      if (sig) { setMint(kp.publicKey.toBase58()); setBought(null); }
      else if (holdsCometail) setError(pairedCopy.launchStep1Done);
      solBalance.reload();
      quoteBalance.reload();
    } catch (e) {
      setError(friendlyError(e, c.launchFailure));
    } finally {
      setPreparing(false);
      setStep(0);
    }
  };
  return (
    <Shell>
      <div className="simple-heading">
        <img src="/art/mascot-launch.webp" alt="" width="200" height="200" />
        <div>
          <h1>{launchCopy.title}</h1>
          <p>{launchCopy.body}</p>
        </div>
      </div>
      <StorageNotice storage={storage} />
      <section className="panel launch-form">
        <fieldset disabled={busy || !!mint || blocked} className="identity-fields">
          <LogoUpload onChange={setImage} />
          <div className="form-row">
            <label className="field">
              {c.name}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                placeholder={c.namePlaceholder}
                autoComplete="off"
              />
            </label>
            <label className="field">
              {launchCopy.ticker}
              <input
                value={symbol}
                onChange={(e) => setSymbol(cleanSymbolInput(e.target.value))}
                maxLength={10}
                placeholder={c.symbolPlaceholder}
                autoComplete="off"
              />
            </label>
          </div>
          <label className="field">
            {c.description}
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder={c.descriptionHint}
            />
          </label>
          <details className="launch-socials">
            <summary>{launchCopy.socials} <span>{c.optional}</span></summary>
            <SocialFields value={links} onChange={setLinks} />
          </details>
          {!linksValid(links) && <p className="form-error" role="alert">{launchCopy.socialsInvalid}</p>}
        </fieldset>
        <LaunchPresets value={presetId} onChange={id => { setPresetId(id); setFirstBuy(""); }} disabled={busy || !!mint || blocked} />
        {!preset.paidInSol && CLUSTER === "devnet" && <p className="form-notice">{c.testQuote}</p>}
        {preset.id === "paired" && <p className="form-notice">{pairedCopy.preset.description} {pairedCopy.preset.firstBuySteps}</p>}
        {preset.id === "paired" && step > 0 && <p className="form-notice" role="status">{step === 1 ? pairedCopy.launchStep1 : pairedCopy.launchStep2}</p>}
        {preset.id === "paired" && pending && step === 0 && !mint && <p className="form-notice">{pairedCopy.launchStep2Pending(formatAmount(BigInt(pending.cometail.toString()), 6, { ticker: "$COMETAIL", maxFraction: 2 }))}</p>}
        {preset.id === "paired" && bought && !pending && !mint && <p className="form-notice">{pairedCopy.launchBoughtElsewhere(formatAmount(BigInt(bought.cometail.toString()), 6, { ticker: "$COMETAIL", maxFraction: 2 }))}</p>}
        <fieldset disabled={busy || !!mint || blocked} className="identity-fields">
          <AmountInput
            label={`${c.firstBuy} · ${c.optional}`}
            unit={quoteTicker}
            value={firstBuy}
            onChange={setFirstBuy}
            balance={!publicKey ? undefined : buyBalance === null ? null : formatAmount(buyBalance, quoteDecimals, { ticker: quoteTicker })}
            quick={quickBuys}
            hint={!preset.paidInSol ? c.quoteFees : publicKey ? amounts.maxKeepsFees : c.firstBuyHint}
            error={firstBuyRaw === null ? c.buyInvalid : shortfall}
            disabled={busy}
          />
        </fieldset>
        <div className="form-actions launch-actions">
          {connected ? (
            <button
              disabled={!valid || busy || !!mint}
              onClick={submit}
              className="button button-primary button-full"
            >
              {busy
                ? status.state === "sending"
                  ? c.creating
                  : c.uploading
                : launchCopy.create}
            </button>
          ) : (
            <ConnectWallet />
          )}
          <p className="launch-cost">{plainLaunch.creationFee} {preset.id === "paired" && firstBuyRaw ? launchCopy.signsPaired : launchCopy.signs}</p>
        </div>
        {(error || status.state === "error") && (
          <p className="form-error" role="alert">
            {error || status.message}
          </p>
        )}
        {status.state === "done" && mint && (
          <div className="success-note" role="status">
            <strong>{c.launchReady}</strong>
            <Link href={`/token/${mint}`}>{c.openToken} ↗</Link>
            <CopyAddress address={mint} />
            <a
              href={EXPLORER("tx", status.signature!)}
              target="_blank"
              rel="noreferrer"
            >
              {c.transaction}
            </a>
          </div>
        )}
      </section>
      <details className="glass-details">
        <summary>{launchCopy.preview}</summary>
        <IdentityPreview name={name} symbol={symbol} image={image?.preview} links={links} />
      </details>
      <details className="glass-details">
        <summary>{plainLaunch.feesToggle}</summary>
        <p>{plainLaunch.feesLine}</p>
        <p>{plainLaunch.intro}</p>
        <p>{plainLaunch.lock}</p>
      </details>
      <details className="glass-details">
        <summary>{launchCopy.details}</summary>
        <p>{plainLaunch.presets.selected}: <strong>{plainLaunch.presets[presetId].name}</strong>{preset.config ? <> · <CopyAddress address={preset.config.toBase58()} /></> : null}</p>
        <p>{c.uploadProof}</p>
        <p>{plainLaunch.presets.shapeNote}</p>
        <p>{presetsPage.launchLink} <Link href="/presets" className="text-link">{presetsPage.launchLinkAction} ↗</Link></p>
      </details>
    </Shell>
  );
}
