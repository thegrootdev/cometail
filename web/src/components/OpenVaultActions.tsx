"use client";
import { friendlyError, DesignedError } from "@/lib/errors";
import { cleanSymbolInput } from "@/lib/token-display";
import { StorageNotice } from "./Experience";
// An Open vault seen by its depositor: withdraw any stream, or finish the launch. This is the
// resume path for a wizard that stopped between transactions.
import { useEffect, useMemo, useState } from "react";
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
  vaultPage,
  wizard,
  experience as c,
  failures,
} from "@/content/cometail";
import { ADDRESSES, EXPLORER } from "@/lib/addresses";
import { loadPool, MigrationProgress } from "@/lib/dbc";
import { cpAmm } from "@/lib/damm";
import { useTx , useStorageReady } from "@/lib/hooks";
import { short } from "@/lib/format";

const KIND = (s: any) => (s?.kind ? Object.keys(s.kind)[0] : "");

/** The wizard stores the fee token's mint key in this browser, keyed by its public key: in local
 *  storage, so another tab or a reload of the same browser still finds it, and in session storage
 *  for the tab that created it. The key only matters until the fee token launches. */
export function storeMintKey(kp: Keypair) {
  const key = `cometail:mint:${kp.publicKey.toBase58()}`, value = JSON.stringify(Array.from(kp.secretKey));
  try { localStorage.setItem(key, value); } catch {}
  try { sessionStorage.setItem(key, value); } catch {}
}
export function loadMintKey(pubkey: string): Keypair | null {
  const key = `cometail:mint:${pubkey}`;
  for (const store of [() => sessionStorage, () => localStorage]) {
    try {
      const raw = store().getItem(key);
      if (!raw) continue;
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
      // a key stored before local storage was used is promoted, so the browser's other tabs find it
      try { if (!localStorage.getItem(key)) localStorage.setItem(key, raw); } catch {}
      return kp;
    } catch {}
  }
  return null;
}
export function forgetMintKey(pubkey: string) {
  const key = `cometail:mint:${pubkey}`;
  try { localStorage.removeItem(key); } catch {}
  try { sessionStorage.removeItem(key); } catch {}
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
  const [hasMintKey, setHasMintKey] = useState<boolean | null>(null);
  useEffect(() => { setHasMintKey(!!loadMintKey(String(v?.stMint ?? ""))); }, [v?.stMint]);
  // the chain's metadata limits in bytes, name and prefixed symbol (a character can be several bytes)
  const nameBytes = new TextEncoder().encode(name.trim()).length;
  const symbolBytes = new TextEncoder().encode(`${product.streamTickerPrefix}${cleanSymbolInput(symbol)}`).length;
  const identityFits = nameBytes > 0 && nameBytes <= 32 && symbolBytes > 1 && symbolBytes <= 10;
  const [image, setImage] = useState<TokenImage | null>(null);
  const [description, setDescription] = useState("");
  const [preparing, setPreparing] = useState(false);
  const storage = useStorageReady();
  const blocked = storage.checked && !storage.ready;
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState(Number(v.preset ?? 1));
  const isDepositor = !!(
    publicKey && String(v.depositor) === publicKey.toBase58()
  );
  // a DBC-rights stream whose pool migrated before its creator position was registered cannot
  // leave yet: the position is registered first, then the withdrawal takes both
  const [needsRegistration, setNeedsRegistration] = useState<Record<number, boolean>>({});
  useEffect(() => {
    let live = true;
    (async () => {
      const next: Record<number, boolean> = {};
      for (const s of streams) {
        if (KIND(s) !== "dbcCreatorRights" || String(s.position) !== PublicKey.default.toBase58()) continue;
        try {
          const pool = await loadPool(connection, new PublicKey(String(s.pool)));
          next[Number(s.index)] = !!pool && pool.progress === MigrationProgress.CreatedPool;
        } catch { /* unreadable pool: the withdrawal reports the program's answer */ }
      }
      if (live) setNeedsRegistration(next);
    })();
    return () => { live = false; };
  }, [connection, streams]);
  if (!isDepositor) return null;
  const vaultPk = new PublicKey(vault);
  const registerPosition = async (s: any, index: number) => {
    setError(null);
    try {
      const dammPool = new PublicKey(String(s.derivedDammPool));
      const positions = await cpAmm(connection).getUserPositionByPool(dammPool, vaultPk);
      const mine = positions[0];
      if (!mine) { setError(vaultPage.unwind.noPositionYet); return; }
      await run(async () => new Transaction().add(await client.registerStreamPosition({
        vault: vaultPk, stream: deriveStream(vaultPk, index), payer: publicKey!, dbcPool: new PublicKey(String(s.pool)), dbcConfig: new PublicKey(String(s.config)), dammPool,
        position: mine.position, nftAccount: mine.positionNftAccount,
      })), [], 300_000);
      onChange();
    } catch (e) {
      setError(friendlyError(e, c.launchFailure));
    }
  };
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
    if (!image || !publicKey || preparing || blocked) return;
    setPreparing(true);
    setError(null);
    try {
      // the wizard keeps the stream token's mint key in this browser session; without it the vault can only be unwound
      const stMint = loadMintKey(String(v.stMint));
      if (!stMint) throw new DesignedError(openVault.needsMintKey);
      const { uri } = await uploadIdentity({
        name,
        symbol: `${product.streamTickerPrefix}${cleanSymbolInput(symbol)}`,
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
          symbol: `${product.streamTickerPrefix}${cleanSymbolInput(symbol)}`,
          uri: uri.trim(),
        },
      });
      const sig = await run(async () => new Transaction().add(L.ix), [stMint], 400_000);
      if (sig) forgetMintKey(String(v.stMint));
      onChange();
    } catch (e) {
      // the plain copy, and the step's own reason when the copy is only the generic line
      const plain = friendlyError(e, c.launchFailure);
      const raw = e instanceof Error ? e.message : String(e ?? "");
      setError(plain === c.launchFailure && raw ? `${plain} ${failures.simulationReason} ${raw.slice(0, 160)}` : plain);
    } finally {
      setPreparing(false);
    }
  };
  const unwound = Object.keys(v?.status ?? {})[0] === "unwound";
  return (
    <Card title={unwound ? vaultPage.unwind.title : openVault.title} className="mt-6">
      <p className="text-sm text-starlight/70">{unwound ? vaultPage.unwind.done : openVault.intro}</p>
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
            {needsRegistration[Number(s.index)] ? (
              <button
                onClick={() => registerPosition(s, Number(s.index))}
                disabled={preparing || status.state === "sending"}
                className="rounded-full border border-starlight/30 px-3 py-1 text-xs"
                title={vaultPage.unwind.registerPositionWhy}
              >
                {vaultPage.unwind.registerPosition}
              </button>
            ) : (
              <button
                onClick={() => withdraw(s, Number(s.index))}
                disabled={preparing || status.state === "sending"}
                className="rounded-full border border-starlight/30 px-3 py-1 text-xs"
              >
                {openVault.withdraw}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!unwound && (<>
      <p className="mt-4 text-xs text-starlight/50">{openVault.mintKeyNote}</p>
      {hasMintKey === false && <p className="form-notice mt-3" role="alert">{openVault.needsMintKey}</p>}
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
              onChange={(e) => setSymbol(cleanSymbolInput(e.target.value))}
              maxLength={9}
            />
          </label>
          {!identityFits && (name.trim() || symbol.trim()) && <p className="form-notice" role="alert">{c.identityLimit}</p>}
        </div>
        <div className="form-row">
          <LogoUpload onChange={setImage} />
          <IdentityPreview
            name={name}
            symbol={cleanSymbolInput(symbol) ? `${product.streamTickerPrefix}${cleanSymbolInput(symbol)}` : ""}
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
        <StorageNotice storage={storage} />
        <button
          onClick={launch}
          disabled={
            !image ||
            blocked ||
            preparing ||
            hasMintKey === false ||
            !name.trim() ||
            !symbol.trim() ||
            !identityFits ||
            streams.length === 0 ||
            status.state === "sending"
          }
          className="rounded-full bg-dust px-5 py-2 text-sm font-semibold text-night disabled:opacity-40"
        >
          {preparing ? c.uploading : openVault.launch}
        </button>
      </div>
      </>)}
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
