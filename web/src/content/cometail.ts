// Every user-facing name, ticker and line of copy lives here. Nothing else in the app
// hardcodes product wording, so a copy review is a review of this one file.

export const product = {
  name: "COMETAIL",
  tagline: "Launch a comet. Sell the tail.",
  domain: "cometail.fun",
  url: "https://cometail.fun",
  description:
    "A Meteora DBC launchpad where every launch grows a tail of fees, and a market where any creator can sell that tail.",
  protocolTicker: "$TAIL",
  streamTickerPrefix: "t",
  builtOn: "Built on Meteora",
  x: "",
} as const;

export const nav = {
  launch: "Launch a token",
  sell: "Sell your tail",
  sky: "The Sky",
  portfolio: "Portfolio",
} as const;

export const hero = {
  title: "Launch a comet. Sell the tail.",
  body: "Every token launched here bonds on Meteora's Dynamic Bonding Curve and graduates into a compounding pool. The fees it earns, for as long as it trades, are its tail. Keep the tail, or sell it.",
  launch: "Launch a token",
  sell: "Sell your tail",
} as const;

export const sky = {
  title: "The Sky",
  body: "Every fee stream on Meteora, drawn as a comet. The longer the tail, the more it earns.",
  legend: { claimable: "claimable now", realized: "harvested, 30 days", locked: "locked liquidity" },
} as const;

export const tokenPage = {
  curve: "Bonding curve",
  progress: "to graduation",
  trades: "Trades",
  tail: "The tail",
  tailBody: "Creator fees this token has earned, before and after graduation.",
  claim: "Claim creator fees",
  sellTail: "Sell this tail",
  buy: "Buy",
  sellToken: "Sell",
} as const;

export const vaultPage = {
  streams: "Streams in this vault",
  income: "Income in",
  cashout: "Cash-out",
  ladder: "Buyback ladder",
  ladderBody: "Standing bids below price, funded by harvested fees. Whatever they fill is burned.",
  burned: "Burned so far",
  bids: "Bids resting",
  cap: "Price cap",
  disclosure:
    "Realized fees fund finite standing buy orders at public limit prices. Holders of this token have no redemption claim and no guaranteed price floor. Orders can exhaust; fee income and market prices can fall. Burning reduces supply but does not guarantee appreciation. Bid placement remains exposed to manipulation and adverse selection. This vault is a disclosed, rule-bound buyback mechanism, not a redeemable claim on income.",
  authority:
    "The vault program is upgradeable by the protocol owner and that is not planned to change. Meteora's DBC and DAMM v2 programs are upgradeable by Meteora, and a Meteora operator can change how much of a compounding pool's fees are claimable. Every number on this page depends on those facts.",
  noGraduation:
    "If this stream token never graduates, the launch is still final: the seller's cash-out never happens and the buyback ladder never starts. The deposited streams keep accruing to the vault.",
} as const;

export const wizard = {
  title: "Sell your tail",
  intro: "Pick the streams you own, choose how much of the raise you take at graduation, and launch the tail as its own token.",
  presets: [
    { key: "stream-25", label: "Take 25%", body: "At graduation, 25% of the raise is yours and 75% becomes permanently locked liquidity." },
    { key: "stream-50", label: "Take 50%", body: "At graduation, half of the raise is yours and half becomes permanently locked liquidity." },
    { key: "stream-75", label: "Take 75%", body: "At graduation, 75% of the raise is yours and 25% becomes permanently locked liquidity." },
  ],
  withdrawLock: "Streams can be withdrawn until you launch. A bonding-curve stream that has completed its curve but not migrated yet cannot be moved until it migrates.",
  irreversible: "Launching is final. After launch, streams stay in the vault.",
  connect: "Connect the wallet that owns the streams.",
  step1: "1. Your streams",
  step2: "2. Your share at graduation",
  step3: "3. The stream token",
  scanning: "Scanning the wallet…",
  nothingFound: "No DBC launches or locked positions found for this wallet.",
  rights: "Creator rights",
  position: "Locked position",
  claimable: "claimable",
  stages: ["bonding", "curve complete", "locked vesting", "graduated"],
  name: "Name",
  symbol: (prefix: string) => `Symbol (shown as ${prefix}SYMBOL)`,
  metadata: "Metadata URL",
  cap: "Highest price the buyback pays, SOL per token",
  capEncoded: "Encoded cap:",
  capInvalid: "Enter a positive price.",
  signing: "Signing…",
  stopped: "Stopped:",
  resumeHint: "The vault exists. Withdraw its streams or finish the launch from the vault page:",
  launched: "Launched.",
  openVault: "Open the vault",
  moneyTitle: "How the money moves",
} as const;

export const openVault = {
  title: "Finish or undo this vault",
  intro: "Nothing has launched yet. Every stream can go back to your wallet, or the stream token can launch now.",
  withdraw: "Withdraw",
  launch: "Launch the stream token",
  mintKeyNote: "Launching needs the stream token key the wizard generated; a vault created in another session can still withdraw its streams here.",
  needsMintKey: "This browser does not hold the stream token key for this vault. Withdraw the streams and start again from Sell your tail.",
} as const;

export const splits = {
  curve: "Curve fees after Meteora's cut: 40% to you, 25% to the protocol, 35% to buybacks.",
  pool: "Graduated pool: half of the fees after Meteora's cut compound into the pool (40% of the gross fee); the protocol holds 20% of the locked liquidity; your vault's claimable fees go half to you, half to buybacks.",
  external: "Income from deposited streams: 20% to the protocol, 80% to buybacks.",
  cashout: "Cash-out: your preset's share of the raise, in full.",
  orderFees: "Fees earned by the buyback bids themselves go back to buybacks.",
} as const;

export const plainLaunch = {
  title: "Launch a token",
  intro: "One flat 1% fee on the curve. While it bonds, 75% of the fee after Meteora's cut is yours (60% of the gross fee). If it graduates, your permanently locked position earns 80% of the pool's claimable fees (32% of the gross fee while half of the LP fees compound), for as long as it trades.",
  creationFee: "0.01 SOL to launch.",
  lock: "If the curve completes, 80% of the graduated liquidity is yours, permanently locked, earning fees for as long as the pool trades.",
} as const;
