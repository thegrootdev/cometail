"use client";
// An Open vault seen by its depositor: withdraw any stream, or finish the launch. This is the
// resume path for a wizard that stopped between transactions.
import { useMemo, useState } from "react";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  VaultClientStep6,
  dammPositionNftAccount,
  deriveStream,
} from "@cometail/client";
import { Card } from "./Shell";
import { LogoUpload, IdentityPreview, type TokenImage } from "./TokenIdentity";
import { uploadIdentity } from "@/lib/upload";
import {
  openVault,
  product,
  wizard,
  experience as c,
} from "@/content/cometail";
import { ADDRESSES, EXPLORER } from "@/lib/addresses";
import { useTx } from "@/lib/hooks";
import { short } from "@/lib/format";

const KIND = (s: any) => (s?.kind ? Object.keys(s.kind)[0] : "");

/** The wizard stores the stream token mint key for the session, keyed by its public key. */
export function storeMintKey(kp: Keypair) {
  try {
    sessionStorage.setItem(
      `cometail:mint:${kp.publicKey.toBase58()}`,
      JSON.stringify(Array.from(kp.secretKey)),
    );
  } catch {}
}
export function loadMintKey(pubkey: string): Keypair | null {
  try {
    const raw = sessionStorage.getItem(`cometail:mint:${pubkey}`);
    return raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : null;
  } catch {
    return null;
  }
}

export function OpenVaultActions({
  vault,
  v,
  streams,
  onChange,
}: {
  vault: string;
  v: any;
  streams: any[];
  onChange: () => void;
}) {
  const { connection } = useConnection();
  const { signMessage } = useWallet();
  const { run, status, publicKey } = useTx();
  const client = useMemo(() => new VaultClientStep6(connection), [connection]);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState<TokenImage | null>(null);
  const [description, setDescription] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState(Number(v.preset ?? 1));
  const isDepositor = !!(
    publicKey && String(v.depositor) === publicKey.toBase58()
  );
  if (!isDepositor) return null;
  const vaultPk = new PublicKey(vault);
  const withdraw = async (s: any, index: number) => {
    const stream = deriveStream(vaultPk, index);
    const dbc = KIND(s) === "dbcCreatorRights";
    const hasPosition = String(s.position) !== PublicKey.default.toBase58();
    const nftMint = hasPosition ? new PublicKey(String(s.nftMint)) : undefined;
    const nftAccount = hasPosition
      ? new PublicKey(String(s.nftAccount))
      : undefined;
    const pda = nftMint ? dammPositionNftAccount(nftMint) : undefined;
    // an NFT in cp-amm's PDA account goes back by authority; any other vault-owned account transfers to the depositor's ATA
    const needsDestination = !!(nftAccount && pda && !nftAccount.equals(pda));
    const destination = needsDestination
      ? getAssociatedTokenAddressSync(
          nftMint!,
          publicKey!,
          false,
          TOKEN_2022_PROGRAM_ID,
        )
      : undefined;
    await run(
      async () => {
        const tx = new Transaction();
        if (destination)
          tx.add(
            createAssociatedTokenAccountIdempotentInstruction(
              publicKey!,
              destination,
              publicKey!,
              nftMint!,
              TOKEN_2022_PROGRAM_ID,
            ),
          );
        return tx.add(
          await client.withdrawStream({
            vault: vaultPk,
            depositor: publicKey!,
            stream,
            kind: dbc ? "dbc" : "position",
            indexKey: new PublicKey(String(dbc ? s.pool : s.position)),
            position:
              dbc && hasPosition
                ? new PublicKey(String(s.position))
                : undefined,
            dbcPool: dbc ? new PublicKey(String(s.pool)) : undefined,
            dbcConfig: dbc ? new PublicKey(String(s.config)) : undefined,
            nftAccount,
            nftMint,
            depositorNftAccount: destination,
          }),
        );
      },
      [],
      300_000,
    );
    onChange();
  };
  const launch = async () => {
    if (!image || !publicKey || preparing) return;
    setPreparing(true);
    setError(null);
    try {
      // the wizard keeps the stream token's mint key in this browser session; without it the vault can only be unwound
      const stMint = loadMintKey(String(v.stMint));
      if (!stMint) throw new Error(openVault.needsMintKey);
      const { uri } = await uploadIdentity({
        name,
        symbol: `${product.streamTickerPrefix}${symbol.trim().toUpperCase()}`,
        description,
        image: image.file,
        owner: publicKey,
        signMessage,
      });
      const L = await client.launch({
        vault: vaultPk,
        depositor: publicKey!,
        stMint: stMint.publicKey,
        config: ADDRESSES.streamConfigs[preset],
        preset,
        streamIndex: Number(v.streamCount),
        metadata: {
          name: name.trim(),
          symbol: `${product.streamTickerPrefix}${symbol.trim().toUpperCase()}`,
          uri: uri.trim(),
        },
      });
      await run(async () => new Transaction().add(L.ix), [stMint], 400_000);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : c.launchFailure);
    } finally {
      setPreparing(false);
    }
  };
  return (
    <Card title={openVault.title} className="mt-6">
      <p className="text-sm text-starlight/70">{openVault.intro}</p>
      <ul className="mt-3 space-y-2 text-sm">
        {streams.map((s: any, i: number) => (
          <li key={i} className="flex items-center justify-between gap-3">
            <span>
              {KIND(s) === "dbcCreatorRights"
                ? "Creator rights"
                : "Locked position"}{" "}
              ·{" "}
              <a
                className="text-ion"
                href={EXPLORER("address", String(s.pool))}
                target="_blank"
                rel="noreferrer"
              >
                {short(String(s.pool))}
              </a>
            </span>
            <button
              onClick={() => withdraw(s, Number(s.index))}
              disabled={preparing || status.state === "sending"}
              className="rounded-full border border-starlight/30 px-3 py-1 text-xs"
            >
              {openVault.withdraw}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-starlight/50">{openVault.mintKeyNote}</p>
      <fieldset
        disabled={preparing || status.state === "sending"}
        className="mt-5 identity-fields"
      >
        <div className="form-row">
          <label className="field">
            {c.name}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
            />
          </label>
          <label className="field">
            {wizard.symbol(product.streamTickerPrefix)}
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              maxLength={9}
            />
          </label>
        </div>
        <div className="form-row">
          <LogoUpload onChange={setImage} />
          <IdentityPreview
            name={name}
            symbol={symbol ? `${product.streamTickerPrefix}${symbol}` : ""}
            image={image?.preview}
          />
        </div>
        <label className="field">
          {c.description}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={2}
          />
        </label>
      </fieldset>
      <p className="caption mt-4">{c.uploadProof}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {wizard.presets.map((p, i) => (
          <button
            key={p.key}
            onClick={() => setPreset(i)}
            disabled={preparing || status.state === "sending"}
            aria-pressed={preset === i}
            className={`rounded-full px-3 py-1 text-xs ${preset === i ? "bg-dust text-night" : "border border-starlight/20"}`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={launch}
          disabled={
            !image ||
            preparing ||
            !name.trim() ||
            !symbol.trim() ||
            streams.length === 0 ||
            status.state === "sending"
          }
          className="rounded-full bg-dust px-5 py-2 text-sm font-semibold text-night disabled:opacity-40"
        >
          {preparing ? c.uploading : openVault.launch}
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {status.state === "error" && (
        <p className="mt-3 text-sm text-red-300">{status.message}</p>
      )}
    </Card>
  );
}
