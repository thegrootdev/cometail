// The launch presets as the site presents them. Numbers are the full-size parameters from
// configs/*.json (the raise is the curve's migration quote threshold); on devnet the Standard
// preset the site launches with is the small e2e config, which the page says.
export type PresetKey = "standard" | "long" | "flat" | "exp" | "stockUsdc" | "stockXstock";
export interface PresetInfo {
  key: PresetKey; name: string; tagline: string; forWhom: string; curve: string;
  quote: "WSOL" | "USDC" | "stock"; quoteLabel: string; quoteDecimals: number;
  initialCap: string; migrationCap: string; raise: string; unit: string; file: string;
  available: boolean;
}
export const presets: PresetInfo[] = [
  { key: "standard", name: "Standard", tagline: "The default comet.", forWhom: "Most launches. A short curve, a quick graduation, then the compounding pool.", curve: "One segment from a 20 SOL to a 120 SOL FDV.", quote: "WSOL", quoteLabel: "SOL", quoteDecimals: 9, initialCap: "20 SOL", migrationCap: "120 SOL", raise: "34.788 SOL", unit: "SOL", file: "configs/plain.json", available: true },
  { key: "long", name: "Long curve", tagline: "Slow price discovery.", forWhom: "Projects that want the price to be found over a longer raise before liquidity locks in.", curve: "Sixteen segments with rising liquidity weights, from a 20 SOL to a 360 SOL FDV.", quote: "WSOL", quoteLabel: "SOL", quoteDecimals: 9, initialCap: "20 SOL", migrationCap: "360 SOL", raise: "122.709 SOL", unit: "SOL", file: "configs/long.json", available: true },
  { key: "flat", name: "Flat curve", tagline: "A fair launch.", forWhom: "Communities that want nearly the same price for everyone who buys before graduation.", curve: "Sixteen segments with the liquidity in the lower band, from a 60 SOL to a 120 SOL FDV, so the price barely moves for most of the raise.", quote: "WSOL", quoteLabel: "SOL", quoteDecimals: 9, initialCap: "60 SOL", migrationCap: "120 SOL", raise: "47.601 SOL", unit: "SOL", file: "configs/flat.json", available: true },
  { key: "exp", name: "Exponential", tagline: "Gentle start. Steeper finish.", forWhom: "Launches that want a gradual opening price climb and sharper price movement as the curve fills.", curve: "Sixteen segments with falling liquidity weights, from a 20 SOL to a 240 SOL FDV. The configured end price is twelve times the start.", quote: "WSOL", quoteLabel: "SOL", quoteDecimals: 9, initialCap: "20 SOL", migrationCap: "240 SOL", raise: "30.675 SOL", unit: "SOL", file: "configs/exp.json", available: true },
  { key: "stockUsdc", name: "Dollar-paired", tagline: "Quoted in USDC.", forWhom: "Launches priced in dollars from the first trade; the curve, the fees and the pool are all in USDC.", curve: "One segment from a 2,000 USDC to a 12,000 USDC FDV.", quote: "USDC", quoteLabel: "USDC", quoteDecimals: 6, initialCap: "2,000 USDC", migrationCap: "12,000 USDC", raise: "3,478.78 USDC", unit: "USDC", file: "configs/stock-usdc.json", available: true },
  { key: "stockXstock", name: "Stock-paired", tagline: "A smaller raise in stock units.", forWhom: "For thinly traded or newly tokenized stock quotes: a smaller raise asks buyers for fewer stock units, while rising liquidity weights put more depth near graduation. Early buys move the price more; the curve cannot remove the quote token’s own volatility or limited liquidity.", curve: "Sixteen segments with rising liquidity weights, from 2 to 16 stock units of FDV.", quote: "stock", quoteLabel: "stock units", quoteDecimals: 8, initialCap: "2 units", migrationCap: "16 units", raise: "5.667 units", unit: "units", file: "configs/stock-xstock.json", available: true },
];
export const presetsPage = {
  kicker: "Pick a curve",
  title: "Launch presets",
  body: "Every preset is a fixed Meteora price-curve setting owned by the protocol. Pick one on the launch page; the curve, the fees and the completion point cannot change, and the pool is yours from the first trade.",
  commonLine: "Same for all: a 1% trade fee with 60% to you while the coin is on its curve, 0.01 SOL to launch, a fixed supply of 1,000,000,000, and liquidity locked for good when the curve completes.",
  feesToggle: "How fees work",
  common: "Common to all: fees in the quote token, a 1% curve fee with 75% of the fee after Meteora’s cut going to the creator, graduation into a compounding pool, 80% of the liquidity permanently locked in your position, immutable metadata, a fixed supply of 1,000,000,000, a 0.01 SOL creation fee.",
  devnetNote: "On devnet the Standard curve the site launches with is 1/80 of these sizes, so a test curve fills with half a SOL.",
  raise: "Raise to graduate", start: "Starting FDV", graduation: "FDV at graduation", quoteIs: "Quote", config: "Config",
  launchWith: "Launch with this preset",
  notOnCluster: "Not created on this network yet.", soon: "Available after the next worker release", explorer: "View config",
  forLaunchpads: "For other launchpads",
  forLaunchpadsBody: "Anyone can create pools on these configs with Meteora's DBC SDK. The program applies the fee split on every swap and sends the partner share to the protocol's fee claimer, with no agreement needed; the creator share goes to whoever created the pool.",
  docs: "The parameters and the rules, in full",
  launchLink: "Six presets to choose from, each a fixed Meteora config.",
  launchLinkAction: "See the presets",
} as const;
