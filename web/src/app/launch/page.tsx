"use client";
import { friendlyError, insufficientSol, insufficientTokens, LAUNCH_OVERHEAD_LAMPORTS } from "@/lib/errors";
import { LaunchPresets } from "@/components/LaunchPresets";
import { LAUNCH_PRESETS, type LaunchPresetId } from "@/lib/launch-presets";
import { useEffect, useState } from "react";
import { CopyAddress } from "@/components/CopyAddress";
import Link from "next/link";
import { Keypair } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { Shell, Card, ConnectWallet } from "@/components/Shell";
import { PageHeader , StorageNotice } from "@/components/Experience";
import {
  LogoUpload,
  IdentityPreview,
  type TokenImage,
} from "@/components/TokenIdentity";
import { plainLaunch, amounts, experience as c } from "@/content/cometail";
import { presetsPage } from "@/content/presets";
import { launchTx } from "@/lib/dbc";
import { uploadIdentity } from "@/lib/upload";
import { SocialFields } from "@/components/SocialLinks";
import { AmountInput } from "@/components/AmountInput";
import { readTokenBalance, useTokenBalance, useSolBalance } from "@/lib/balances";
import { formatAmount, inputValue, parseAmount, spendable } from "@/lib/amounts";
import { cleanLinks, linksValid, type TokenLinks } from "@/lib/token-display";
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
  const storage = useStorageReady();
  const blocked = storage.checked && !storage.ready;
  const solBalance = useSolBalance(publicKey);
  const quoteBalance = useTokenBalance(preset.native ? null : preset.quoteMint, publicKey);
  const quoteDecimals = preset.quote.decimals ?? 9;
  const quoteTicker = preset.quote.symbol;
  const buyBalance = preset.native ? solBalance.lamports : quoteBalance.raw;
  // the typed first buy in quote base units: 0n when empty, null when malformed
  const firstBuyRaw = firstBuy.trim() ? parseAmount(firstBuy, quoteDecimals) : 0n;
  const need = (preset.native ? firstBuyRaw ?? 0n : 0n) + LAUNCH_OVERHEAD_LAMPORTS;
  // the shortfall is said at the field, before anything is signed
  const shortfall = publicKey && firstBuyRaw !== null && solBalance.lamports !== null && solBalance.lamports < need ? insufficientSol(need, solBalance.lamports) : publicKey && !preset.native && firstBuyRaw !== null && buyBalance !== null && buyBalance < firstBuyRaw ? insufficientTokens(formatAmount(firstBuyRaw, quoteDecimals, { ticker: quoteTicker }), formatAmount(buyBalance, quoteDecimals, { ticker: quoteTicker })) : null;
  const quickBuys = [...["0.1", "0.5", "1"].map((v) => ({ label: `${v} ${quoteTicker}`, value: v })), { label: amounts.max, value: buyBalance === null ? null : inputValue(preset.native ? spendable(buyBalance, LAUNCH_OVERHEAD_LAMPORTS) ?? 0n : buyBalance, quoteDecimals) }];
  const valid =
    !!preset.config &&
    linksValid(links) &&
    firstBuyRaw !== null &&
    !shortfall &&
    !!image &&
    new TextEncoder().encode(name.trim()).length > 0 &&
    new TextEncoder().encode(name.trim()).length <= 32 &&
    new TextEncoder().encode(symbol.trim().toUpperCase()).length > 0 &&
    new TextEncoder().encode(symbol.trim().toUpperCase()).length <= 10;
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
        const need = (preset.native ? BigInt(lamports?.toString() ?? "0") : 0n) + LAUNCH_OVERHEAD_LAMPORTS;
        const have = BigInt(await connection.getBalance(publicKey));
        if (have < need) { setError(insufficientSol(need, have)); return; }
      }
      if (!preset.native && firstBuyRaw && preset.quoteMint) {
        const have = await readTokenBalance(connection, preset.quoteMint, publicKey);
        if (have < firstBuyRaw) { setError(insufficientTokens(formatAmount(firstBuyRaw, quoteDecimals, { ticker: quoteTicker }), formatAmount(have, quoteDecimals, { ticker: quoteTicker }))); return; }
      }
      const { uri } = await uploadIdentity({
        name,
        symbol: symbol.toUpperCase(),
        description,
        links: cleanLinks(links),
        image: image.file,
        owner: publicKey,
        signMessage,
      });
      const kp = Keypair.generate();
      const sig = await run(
        () =>
          launchTx(connection, {
            config: preset.config!,
            payer: publicKey,
            baseMint: kp.publicKey,
            name: name.trim(),
            symbol: symbol.trim().toUpperCase(),
            uri,
            firstBuyRaw: lamports,
            quoteMint: preset.quoteMint!,
            quoteDecimals,
          }),
        [kp],
      );
      if (sig) setMint(kp.publicKey.toBase58());
      solBalance.reload();
      quoteBalance.reload();
    } catch (e) {
      setError(friendlyError(e, c.launchFailure));
    } finally {
      setPreparing(false);
    }
  };
  return (
    <Shell>
      <PageHeader
        art="launch"
        eyebrow={c.launchKicker}
        title={plainLaunch.title}
        body={c.launchBody}
      />
      <p className="form-notice presets-link">{presetsPage.launchLink} <Link href="/presets" className="text-link">{presetsPage.launchLinkAction} ↗</Link></p>
      <div className="launch-layout">
        <Card title={c.identity}>
          <StorageNotice storage={storage} />
          <LaunchPresets value={presetId} onChange={id => { setPresetId(id); setFirstBuy(""); }} disabled={busy || !!mint || blocked} />
          {!preset.native && CLUSTER === "devnet" && <p className="form-notice">{c.testQuote}</p>}
          <fieldset disabled={busy || !!mint || blocked} className="identity-fields">
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
                {c.symbol}
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  maxLength={10}
                  placeholder={c.symbolPlaceholder}
                  autoComplete="off"
                />
              </label>
            </div>
            <LogoUpload onChange={setImage} />
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
            <SocialFields value={links} onChange={setLinks} />
            <AmountInput
              label={`${c.firstBuy} · ${c.optional}`}
              unit={quoteTicker}
              value={firstBuy}
              onChange={setFirstBuy}
              balance={!publicKey ? undefined : buyBalance === null ? null : formatAmount(buyBalance, quoteDecimals, { ticker: quoteTicker })}
              quick={quickBuys}
              hint={!preset.native ? c.quoteFees : publicKey ? amounts.maxKeepsFees : c.firstBuyHint}
              error={firstBuyRaw === null ? c.buyInvalid : shortfall}
              disabled={busy}
            />
          </fieldset>
          <div className="form-actions">
            {connected ? (
              <button
                disabled={!valid || busy || !!mint}
                onClick={submit}
                className="button button-primary"
              >
                {busy
                  ? status.state === "sending"
                    ? c.creating
                    : c.uploading
                  : c.launchAction}
                <span aria-hidden>↗</span>
              </button>
            ) : (
              <ConnectWallet />
            )}
            <p className="caption">{c.uploadProof}</p>
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
        </Card>
        <aside className="preview-column">
          <IdentityPreview name={name} symbol={symbol} image={image?.preview} links={links} />
          <Card title={c.review}>
            <p className="caption">{plainLaunch.presets.selected}: <strong>{plainLaunch.presets[presetId].name}</strong></p>
            <p className="creation-fee">{plainLaunch.creationFee}</p>
            <p className="fees-line">{plainLaunch.feesLine}</p>
            <details className="fees-details">
              <summary>{plainLaunch.feesToggle}</summary>
              <p className="disclosure-copy">{plainLaunch.intro}</p>
              <p className="disclosure-copy">{plainLaunch.lock}</p>
            </details>
          </Card>
        </aside>
      </div>
    </Shell>
  );
}
