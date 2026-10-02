"use client";
import { friendlyError } from "@/lib/errors";
// "Sell your tail": scan the wallet for streams it owns, pick, choose a preset, launch.
// One transaction per step so a wallet shows exactly what each signature does; the vault
// link appears as soon as the vault exists, and the vault page can withdraw or finish later.
import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { VaultClientStep6, handPositionNftToVaultIx } from "@cometail/client";
import { Shell, Card, ConnectWallet } from "@/components/Shell";
import { storeMintKey } from "@/components/OpenVaultActions";
import {
  LogoUpload,
  IdentityPreview,
  type TokenImage,
} from "@/components/TokenIdentity";
import { DataState, PageHeader , StorageNotice } from "@/components/Experience";
import { uploadIdentity } from "@/lib/upload";
import { wizard, splits, product, experience as c } from "@/content/cometail";
import { ADDRESSES, EXPLORER } from "@/lib/addresses";
import {
  dbcClient,
  derivedDammPool,
  poolsByCreator,
  MigrationProgress,
} from "@/lib/dbc";
import { cpAmm } from "@/lib/damm";
import {
  creatorPositionQualifies,
  dbcRightsReasons,
  mintReasons,
  nftAccountReasons,
  positionReasons,
} from "@/lib/eligibility";
import { useLoad, useTx , useStorageReady } from "@/lib/hooks";
import { capToQ64, q64ToCap } from "@/lib/q64";
import { short, sol } from "@/lib/format";

type RightsStream = {
  kind: "rights";
  pool: PublicKey;
  config: PublicKey;
  baseMint: PublicKey;
  progress: number;
  claimable: BN;
  reasons: string[];
  creatorPos?: {
    position: PublicKey;
    nftAccount: PublicKey;
    nftMint: PublicKey;
  };
  dammPool: PublicKey;
};
type PositionStream = {
  kind: "position";
  pool: PublicKey;
  position: PublicKey;
  nftAccount: PublicKey;
  nftMint: PublicKey;
  baseMint: PublicKey;
  reasons: string[];
};
type Stream = RightsStream | PositionStream;
const key = (s: Stream) =>
  (s.kind === "rights" ? s.pool : s.position).toBase58();
/** Compute units per step: measured launch 187k on devnet, 241k against the pinned mainnet binaries; deposits well under 300k. */
const CU = { createVault: 200_000, deposit: 400_000, launch: 500_000 };

function Wizard() {
  const params = useSearchParams();
  const preselect = params.get("pool");
  const { connection } = useConnection();
  const { signMessage } = useWallet();
  const { run, status, publicKey } = useTx();
  const client = useMemo(() => new VaultClientStep6(connection), [connection]);
  const {
    data: streams,
    loading,
    error,
    reload,
  } = useLoad<Stream[]>(async () => {
    if (!publicKey) return [];
    const out: Stream[] = [];
    const dbc = dbcClient(connection);
    const amm = cpAmm(connection);
    const [pools, positions] = await Promise.all([
      poolsByCreator(connection, publicKey),
      amm.getPositionsByUser(publicKey),
    ]);
    const bundled = new Set<string>();
    for (const { pool, state } of pools) {
      const config: any = await dbc.state.getPoolConfig(state.config);
      const reasons = config
        ? dbcRightsReasons(config, state)
        : ["config missing"];
      reasons.push(...(await mintReasons(connection, state.baseMint)).reasons);
      const progress = Number(state.migrationProgress);
      const option = config ? Number(config.migrationFeeOption) : 6;
      const dammPool = derivedDammPool(state.baseMint, option);
      const s: RightsStream = {
        kind: "rights",
        pool,
        config: state.config,
        baseMint: state.baseMint,
        progress,
        claimable: new BN(state.creatorQuoteFee.toString()),
        reasons,
        dammPool,
      };
      if (progress === MigrationProgress.CreatedPool && config) {
        // among the wallet's positions in the migrated pool, the one the program admits as the creator position
        const poolState: any = await amm
          .fetchPoolState(dammPool)
          .catch(() => null);
        const candidates = positions.filter((p) =>
          new PublicKey(p.positionState.pool).equals(dammPool),
        );
        const creatorPos = poolState
          ? candidates.find(
              (p) =>
                positionReasons(poolState, p.positionState).length === 0 &&
                creatorPositionQualifies(
                  poolState,
                  p.positionState,
                  Number(config.creatorPermanentLockedLiquidityPercentage),
                  Number(config.partnerPermanentLockedLiquidityPercentage),
                ),
            )
          : undefined;
        if (creatorPos) {
          s.creatorPos = {
            position: creatorPos.position,
            nftAccount: creatorPos.positionNftAccount,
            nftMint: new PublicKey(creatorPos.positionState.nftMint),
          };
          s.reasons.push(
            ...(await nftAccountReasons(
              connection,
              creatorPos.positionNftAccount,
            )),
          );
          bundled.add(creatorPos.position.toBase58());
        } else s.reasons.push("the creator position is not in this wallet");
      }
      out.push(s);
    }
    for (const p of positions) {
      if (bundled.has(p.position.toBase58())) continue; // travels with its rights above; every other position stands alone
      const poolKey = new PublicKey(p.positionState.pool);
      const poolState: any = await amm
        .fetchPoolState(poolKey)
        .catch(() => null);
      if (!poolState) continue;
      const reasons = [
        ...positionReasons(poolState, p.positionState),
        ...(await mintReasons(connection, poolState.tokenAMint)).reasons,
        ...(await nftAccountReasons(connection, p.positionNftAccount)),
      ];
      out.push({
        kind: "position",
        pool: poolKey,
        position: p.position,
        nftAccount: p.positionNftAccount,
        nftMint: new PublicKey(p.positionState.nftMint),
        baseMint: poolState.tokenAMint,
        reasons,
      });
    }
    return out;
  }, [publicKey?.toBase58()]);
  const [picked, setPicked] = useState<Set<string>>(
    new Set(preselect ? [preselect] : []),
  );
  const [preset, setPreset] = useState(1);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState<TokenImage | null>(null);
  const [description, setDescription] = useState("");
  const [preparing, setPreparing] = useState(false);
  const storage = useStorageReady();
  const blocked = storage.checked && !storage.ready;
  const [capSol, setCapSol] = useState("0.01");
  const [log, setLog] = useState<string[]>([]);
  const [vaultKey, setVaultKey] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);
  const eligible = (streams ?? []).filter((s) => s.reasons.length === 0);
  const chosen = eligible.filter((s) => picked.has(key(s)));
  const capQ64 = capToQ64(capSol, 6);
  const ready =
    chosen.length > 0 &&
    image &&
    !preparing &&
    name.trim() &&
    symbol.trim() &&
    publicKey &&
    capQ64 &&
    status.state !== "sending" &&
    !vaultKey;

  const launch = async () => {
    if (!publicKey || !capQ64 || !image || preparing || blocked) return;
    setPreparing(true);
    try {
      const { uri } = await uploadIdentity({
        name,
        symbol: `${product.streamTickerPrefix}${symbol.trim().toUpperCase()}`,
        description,
        image: image.file,
        owner: publicKey,
        signMessage,
      });
      const stMint = Keypair.generate();
      storeMintKey(stMint);
      const policy = {
        maxSpendPerPeriod: new BN(5_000_000_000),
        periodSeconds: new BN(3600),
        maxOutstandingOrders: 4,
        maxBinsPerOrder: 20,
        maxPriceQ64: capQ64,
      };
      const cv = await client.createVault({
        depositor: publicKey,
        stMint: stMint.publicKey,
        policy,
      });
      const step = async (
        label: string,
        build: () => Promise<Transaction>,
        signers: Keypair[],
        cu: number,
      ) => {
        const sig = await run(build, signers, cu);
        setLog((l) => [...l, `${label}: ${sig ?? "failed"}`]);
        if (!sig) throw new Error(label);
      };
      await step(
        "create vault",
        async () => new Transaction().add(cv.ix),
        [cv.placeholder, stMint],
        CU.createVault,
      );
      setVaultKey(cv.vault.toBase58());
      const dbc = dbcClient(connection);
      let index = 0;
      for (const s of chosen) {
        if (s.kind === "rights") {
          const xfer = await dbc.creator.transferPoolCreator({
            pool: s.pool,
            creator: publicKey,
            newCreator: cv.vault,
          });
          if (s.progress === MigrationProgress.PreBondingCurve) {
            const dep = await client.depositDbcRights({
              vault: cv.vault,
              depositor: publicKey,
              streamIndex: index,
              dbcPool: s.pool,
              dbcConfig: s.config,
              baseMint: s.baseMint,
            });
            await step(
              `deposit rights ${short(s.baseMint.toBase58())}`,
              async () => new Transaction().add(...xfer.instructions, dep),
              [],
              CU.deposit,
            );
          } else {
            const dep = await client.depositDbcRightsMigrated({
              vault: cv.vault,
              depositor: publicKey,
              streamIndex: index,
              dbcPool: s.pool,
              dbcConfig: s.config,
              baseMint: s.baseMint,
              dammPool: s.dammPool,
              creatorPosition: s.creatorPos!.position,
              creatorNftAccount: s.creatorPos!.nftAccount,
            });
            await step(
              `deposit rights + position ${short(s.baseMint.toBase58())}`,
              async () =>
                new Transaction().add(
                  ...xfer.instructions,
                  handPositionNftToVaultIx(
                    s.creatorPos!.nftMint,
                    publicKey,
                    cv.vault,
                  ),
                  dep,
                ),
              [],
              CU.deposit,
            );
          }
        } else {
          const dep = await client.depositPosition({
            vault: cv.vault,
            depositor: publicKey,
            streamIndex: index,
            dammPool: s.pool,
            position: s.position,
            nftMint: s.nftMint,
            nftAccount: s.nftAccount,
            baseMint: s.baseMint,
          });
          await step(
            `deposit position ${short(s.position.toBase58())}`,
            async () =>
              new Transaction().add(
                handPositionNftToVaultIx(s.nftMint, publicKey, cv.vault),
                dep,
              ),
            [],
            CU.deposit,
          );
        }
        index++;
      }
      const L = await client.launch({
        vault: cv.vault,
        depositor: publicKey,
        stMint: stMint.publicKey,
        config: ADDRESSES.streamConfigs[preset],
        preset,
        streamIndex: index,
        metadata: {
          name: name.trim(),
          symbol: `${product.streamTickerPrefix}${symbol.trim().toUpperCase()}`,
          uri: uri.trim(),
        },
      });
      await step(
        "launch the stream token",
        async () => new Transaction().add(L.ix),
        [stMint],
        CU.launch,
      );
      setLaunched(true);
    } catch (e) {
      setLog((l) => [
        ...l,
        `${wizard.stopped} ${friendlyError(e, c.launchFailure)}`,
      ]);
    } finally {
      setPreparing(false);
    }
  };

  return (
    <>
      <PageHeader
        art="sell"
        eyebrow={c.sellKicker}
        title={wizard.title}
        body={c.sellBody}
      />
      {!publicKey && (
        <div className="launch-layout">
          <DataState kind="wallet" title={c.connectTitle} body={wizard.connect}>
            <ConnectWallet />
          </DataState>
          <Card title={wizard.moneyTitle}>
            <ul className="disclosure-list">
              <li>{splits.curve}</li>
              <li>{splits.pool}</li>
              <li>{splits.external}</li>
              <li>{splits.cashout}</li>
              <li>{splits.orderFees}</li>
            </ul>
          </Card>
        </div>
      )}
      {publicKey && (
        <div className="launch-layout">
          <div className="space-y-6">
            <Card title={wizard.step1}>
              {loading && (
                <DataState kind="loading" compact title={wizard.scanning} />
              )}
              {!loading && error && (
                <DataState kind="error" compact onRetry={reload} />
              )}
              {!loading && !error && (streams ?? []).length === 0 && (
                <DataState
                  kind="empty"
                  compact
                  title={c.noStreams}
                  body={c.noStreamsBody}
                >
                  <Link className="button button-secondary" href="/launch">
                    {c.launchAction} ↗
                  </Link>
                </DataState>
              )}
              <ul className="space-y-2">
                {(streams ?? []).map((s) => {
                  const k = key(s);
                  const ok = s.reasons.length === 0;
                  return (
                    <li
                      key={k}
                      className={`flex items-start gap-3 rounded-xl border border-starlight/10 p-3 ${ok ? "" : "opacity-60"}`}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${s.kind === "rights" ? wizard.rights : wizard.position} ${k}`}
                        disabled={!ok || !!vaultKey || preparing}
                        checked={picked.has(k)}
                        onChange={(e) => {
                          const n = new Set(picked);
                          if (e.target.checked) n.add(k);
                          else n.delete(k);
                          setPicked(n);
                        }}
                        className="mt-1"
                      />
                      <div className="text-sm">
                        <div>
                          {s.kind === "rights"
                            ? wizard.rights
                            : wizard.position}{" "}
                          ·{" "}
                          <Link
                            href={`/token/${s.baseMint.toBase58()}`}
                            className="text-ion"
                          >
                            {short(s.baseMint.toBase58())}
                          </Link>
                          {s.kind === "rights" && (
                            <span className="text-starlight/60">
                              {" "}
                              · {wizard.stages[s.progress]} · {sol(s.claimable)}{" "}
                              {wizard.claimable}
                            </span>
                          )}
                        </div>
                        {!ok && (
                          <div className="text-xs text-starlight/50">
                            {s.reasons.join("; ")}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-xs text-starlight/50">
                {wizard.withdrawLock}
              </p>
            </Card>
            <Card title={wizard.step2}>
              <div className="grid gap-3 sm:grid-cols-3">
                {wizard.presets.map((p, i) => (
                  <button
                    key={p.key}
                    onClick={() => setPreset(i)}
                    disabled={!!vaultKey || preparing || blocked}
                    aria-pressed={preset === i}
                    className={`rounded-xl border p-3 text-left ${preset === i ? "border-dust" : "border-starlight/15"}`}
                  >
                    <div className="font-semibold text-dust">{p.label}</div>
                    <div className="mt-1 text-xs text-starlight/70">
                      {p.body}
                    </div>
                  </button>
                ))}
              </div>
            </Card>
            <Card title={wizard.step3}>
              <StorageNotice storage={storage} />
              <fieldset disabled={preparing || !!vaultKey || blocked}>
                <label className="block text-sm">
                  {wizard.name}
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={32}
                    className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2"
                  />
                </label>
                <label className="mt-3 block text-sm">
                  {wizard.symbol(product.streamTickerPrefix)}
                  <input
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                    maxLength={9}
                    className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2"
                  />
                </label>
                <div className="mt-5">
                  <LogoUpload onChange={setImage} />
                </div>
                <label className="field mt-4">
                  {c.description}
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={500}
                    rows={3}
                    placeholder={c.descriptionHint}
                  />
                </label>
                <label className="mt-3 block text-sm">
                  {wizard.cap}
                  <input
                    value={capSol}
                    onChange={(e) => setCapSol(e.target.value)}
                    inputMode="decimal"
                    className="mt-1 w-full rounded-lg border border-starlight/15 bg-night px-3 py-2"
                  />
                </label>
                <p className="mt-1 text-xs text-starlight/50">
                  {capQ64
                    ? `${wizard.capEncoded} ${q64ToCap(capQ64, 6)} SOL/token`
                    : wizard.capInvalid}
                </p>
              </fieldset>
              <p className="caption mt-4">{c.uploadProof}</p>
              <button
                disabled={!ready}
                onClick={launch}
                className="mt-5 rounded-full bg-dust px-6 py-3 font-semibold text-night disabled:opacity-40"
              >
                {preparing
                  ? status.state === "sending"
                    ? wizard.signing
                    : c.uploading
                  : wizard.title}
              </button>
              <p className="mt-3 text-xs text-starlight/50">
                {wizard.irreversible}
              </p>
              {log.length > 0 && (
                <ul className="mt-4 space-y-1 text-xs text-starlight/70">
                  {log.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              )}
              {status.state === "error" && (
                <p className="mt-2 text-sm text-red-300">{status.message}</p>
              )}
              {vaultKey && !launched && status.state !== "sending" && (
                <p className="mt-3 text-sm">
                  {wizard.resumeHint}{" "}
                  <Link href={`/vault/${vaultKey}`} className="text-ion">
                    {short(vaultKey)}
                  </Link>
                </p>
              )}
              {launched && vaultKey && (
                <p className="mt-3 text-sm">
                  {wizard.launched}{" "}
                  <Link href={`/vault/${vaultKey}`} className="text-ion">
                    {wizard.openVault}
                  </Link>{" "}
                  ·{" "}
                  <a
                    href={EXPLORER("address", vaultKey)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-starlight/60"
                  >
                    explorer
                  </a>
                </p>
              )}
            </Card>
          </div>
          <aside className="preview-column">
            <IdentityPreview
              name={name}
              symbol={symbol ? `${product.streamTickerPrefix}${symbol}` : ""}
              image={image?.preview}
            />
            <Card title={wizard.moneyTitle}>
              <ul className="space-y-3 text-sm text-starlight/80">
                <li>{splits.curve}</li>
                <li>{splits.pool}</li>
                <li>{splits.external}</li>
                <li>{splits.cashout}</li>
                <li>{splits.orderFees}</li>
              </ul>
            </Card>
          </aside>
        </div>
      )}
    </>
  );
}

export default function SellPage() {
  return (
    <Shell>
      <Suspense fallback={<DataState kind="loading" />}>
        <Wizard />
      </Suspense>
    </Shell>
  );
}
