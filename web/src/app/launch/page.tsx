"use client";
import { useState } from "react";
import Link from "next/link";
import { Keypair } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { Shell, Card, ConnectWallet } from "@/components/Shell";
import { PageHeader } from "@/components/Experience";
import {
  LogoUpload,
  IdentityPreview,
  type TokenImage,
} from "@/components/TokenIdentity";
import { plainLaunch, experience as c } from "@/content/cometail";
import { launchTx } from "@/lib/dbc";
import { uploadIdentity } from "@/lib/upload";
import { useTx } from "@/lib/hooks";
import { EXPLORER } from "@/lib/addresses";

export default function LaunchPage() {
  const { connection } = useConnection();
  const { signMessage } = useWallet();
  const { run, status, connected, publicKey } = useTx();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState<TokenImage | null>(null);
  const [firstBuy, setFirstBuy] = useState("");
  const [mint, setMint] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid =
    !!image &&
    new TextEncoder().encode(name.trim()).length > 0 &&
    new TextEncoder().encode(name.trim()).length <= 32 &&
    new TextEncoder().encode(symbol.trim().toUpperCase()).length > 0 &&
    new TextEncoder().encode(symbol.trim().toUpperCase()).length <= 10 &&
    (!firstBuy || /^\d{1,9}(\.\d{1,9})?$/.test(firstBuy));
  const busy = preparing || status.state === "sending";
  const submit = async () => {
    if (!valid || !image || !publicKey || busy) return;
    setPreparing(true);
    setError(null);
    try {
      const { uri } = await uploadIdentity({
        name,
        symbol: symbol.toUpperCase(),
        description,
        image: image.file,
        owner: publicKey,
        signMessage,
      });
      const kp = Keypair.generate();
      const [whole, fraction = ""] = (firstBuy || "0").split(".");
      const lamports = firstBuy
        ? new BN(whole).mul(new BN(1e9)).add(new BN(fraction.padEnd(9, "0")))
        : undefined;
      const sig = await run(
        () =>
          launchTx(connection, {
            payer: publicKey,
            baseMint: kp.publicKey,
            name: name.trim(),
            symbol: symbol.trim().toUpperCase(),
            uri,
            firstBuyLamports: lamports,
          }),
        [kp],
      );
      if (sig) setMint(kp.publicKey.toBase58());
    } catch (e) {
      setError(e instanceof Error ? e.message : c.launchFailure);
    } finally {
      setPreparing(false);
    }
  };
  return (
    <Shell>
      <PageHeader
        eyebrow={c.launchKicker}
        title={plainLaunch.title}
        body={c.launchBody}
      />
      <div className="launch-layout">
        <Card title={c.identity}>
          <fieldset disabled={busy || !!mint} className="identity-fields">
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
            <label className="field">
              {c.firstBuy} <span className="muted">{c.optional}</span>
              <div className="amount-input">
                <input
                  value={firstBuy}
                  onChange={(e) => setFirstBuy(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                />
                <span>SOL</span>
              </div>
              <small>
                {firstBuy && !/^\d{1,9}(\.\d{1,9})?$/.test(firstBuy)
                  ? c.buyInvalid
                  : c.firstBuyHint}
              </small>
            </label>
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
          <IdentityPreview name={name} symbol={symbol} image={image?.preview} />
          <Card title={c.review}>
            <p className="creation-fee">{plainLaunch.creationFee}</p>
            <p className="disclosure-copy">{plainLaunch.intro}</p>
            <p className="disclosure-copy">{plainLaunch.lock}</p>
          </Card>
        </aside>
      </div>
    </Shell>
  );
}
