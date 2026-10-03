import Link from "next/link";
import { CopyAddress } from "@/components/CopyAddress";
import { PageHeader } from "@/components/Experience";
import { Shell, Card } from "@/components/Shell";
import { presets, presetsPage as c } from "@/content/presets";
import { product } from "@/content/cometail";
import { ADDRESSES, CLUSTER, EXPLORER } from "@/lib/addresses";

export const metadata = { title: `${c.title} · ${product.name}`, description: c.body };

const configOf = (key: string): string | null => {
  switch (key) {
    case "long": return ADDRESSES.presets.long?.toBase58() ?? null;
    case "flat": return ADDRESSES.presets.flat?.toBase58() ?? null;
    case "stockUsdc": return ADDRESSES.presets.stockUsdc?.toBase58() ?? null;
    case "stockXstock": return ADDRESSES.presets.stockXstock?.toBase58() ?? null;
    default: return ADDRESSES.plainConfig.toBase58();
  }
};

export default function PresetsPage() {
  return (
    <Shell>
      <PageHeader art="launch" eyebrow={c.kicker} title={c.title} body={c.body} />
      <p className="form-notice presets-common">{c.common}</p>
      {CLUSTER !== "mainnet-beta" && <p className="caption presets-devnet">{c.devnetNote}</p>}
      <div className="presets-grid">
        {presets.map((p) => (
          <Card key={p.key} title={p.name} className={`preset-card preset-${p.key}`}>
            <p className="preset-tagline">{p.tagline}</p>
            <p className="preset-for">{p.forWhom}</p>
            <p className="caption preset-curve">{p.curve}</p>
            <dl className="preset-facts">
              <div><dt>{c.raise}</dt><dd>{p.raise}</dd></div>
              <div><dt>{c.start}</dt><dd>{p.initialCap}</dd></div>
              <div><dt>{c.graduation}</dt><dd>{p.migrationCap}</dd></div>
              <div><dt>{c.quoteIs}</dt><dd>{p.quoteLabel}</dd></div>
            </dl>
            {configOf(p.key) ? (
              <div className="preset-config">
                <CopyAddress address={configOf(p.key)!} label={c.config} />
                <a className="text-link" href={EXPLORER("address", configOf(p.key)!)} target="_blank" rel="noopener noreferrer">{c.explorer} ↗</a>
              </div>
            ) : (
              <p className="caption preset-config">{c.notOnCluster}</p>
            )}
            {p.available && configOf(p.key) ? (
              <Link href={`/launch?preset=${p.key}`} className="button button-primary preset-action">{c.launchWith} ↗</Link>
            ) : (
              <span className="button button-secondary preset-action" aria-disabled="true">{c.soon}</span>
            )}
          </Card>
        ))}
      </div>
      <Card title={c.forLaunchpads} className="presets-launchpads">
        <p>{c.forLaunchpadsBody}</p>
        <pre className="preset-snippet"><code>{`import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
const client = new DynamicBondingCurveClient(connection, "confirmed");
const tx = await client.pool.createPool({ config: PRESET_CONFIG, baseMint, name, symbol, uri, payer, poolCreator });`}</code></pre>
        <a className="text-link" href={`${product.github}/blob/main/docs/presets.md`} target="_blank" rel="noopener noreferrer">{c.docs} ↗</a>
      </Card>
    </Shell>
  );
}
