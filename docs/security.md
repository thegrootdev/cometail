# Security model

## Who holds what

- Every mainnet authority (program upgrade, protocol admin, treasury, partner configs) is
  the protocol owner's own wallet. That wallet never touches the build machine. Deploys and
  upgrades are signed from a verifiable build on the owner's machine.
- Revoking the upgrade authority is not planned. That means the program's asset-handling
  code can be replaced by the owner regardless of the admin restrictions below. Every vault
  page says so.
- Meteora's DBC and DAMM v2 programs are upgradeable by Meteora, and a Meteora operator
  can change how much of a compounding pool's fees are claimable. Every vault page says so.
- The keeper runs with a hot key. Its powers are placing bids and settling partially filled
  bids, inside the vault's on-chain policy. It cannot move assets anywhere else. The admin
  can rotate it.

## What the program will not do

- Move assets to any account the vault does not own, except the depositor's recorded payout
  account, the protocol treasury, withdrawals before launch or after unwind, and the
  settlement caller receiving closed order-account rent.
- Swap anything. Income is WSOL only; streams whose fees arrive in anything else are
  rejected at deposit.
- Accept a client's word for anything it can read from the chain: eligibility, ownership,
  provenance of the vault's own streams, which position may register as a migrated
  creator position (canonical custody plus exact size rules against the current
  permanently locked total; the chain records no role, so the program promises a size,
  not an identity), order ownership, fill state.
- Launch a vault whose streams were all withdrawn: the count of open streams, not the
  number ever created, gates the launch.
- Bind a DLMM pair chosen by a stranger, or one whose base fee is above 1%.
- Let any source enter twice, or stay blocked after a withdrawal: a creator position that
  came in with DBC rights has its own index, and withdrawals close every index they own.
- Let a harvest happen before launch, so a withdrawal before launch always returns the
  stream with its fees attached.
- Place anything but buy orders, above the depositor's price cap, past the period budget or
  the resting-order cap.
- Leave stream tokens in the vault after a settlement: every `settle` burns the whole
  balance before it returns (tokens sent to the vault between settlements wait for the
  next one).

## The burn program

`programs/cometail_burn` is a separate program; the vault program is unchanged by it (`docs/burn.md`).

- Its upgrade authority is the owner's wallet, kept through a review period; removing it is the owner's later
  decision, for this program only. Until then, "no withdrawal" is a property of the current code.
- Setup can run once, signed by that upgrade authority (bound through the program's own ProgramData). It pins
  the $COMETAIL mint, its DAMM v2 pool and that pool's fee settings, and the protocol treasury.
- There is no admin and no withdrawal instruction. No instruction takes an argument. Every transfer goes to a
  pinned or derived account: the reserve, the treasury, the pool's vaults in a swap, a burn.
- Every instruction is permissionless. The keeper runs them with its hot key and only pays network fees; no
  instruction pays its caller or takes a destination, so the hot key can never send funds anywhere it controls.
- The program never closes or unwraps the protocol treasury: it only transfers wrapped SOL into it.
- A buyback spends min(reserve, cap) with cap = pool SOL reserve x fee / 5, at most once every ten minutes, at
  least 0.001 SOL, with the program's own minimum out, and only while the pool's fee settings equal those at
  setup. In the constant-product model a sandwich around one buyback loses money (gate 20 measures six sizes);
  this is not a claim of general MEV resistance or of a fair external price.
- Meteora can upgrade its programs and an operator can change a pool's fees: the program then refuses to buy.
  If the pool stops working, the reserve waits; after the authority is removed it could be stranded.
- Owner claims (older configs and positions) are signed by their owner; the program measures what the claim pays
  and sends exactly half to the reserve and half only to the signer's own WSOL account. `/admin/fees` claims SOL
  through them while the program is live and refuses to build a SOL claim while the program's state cannot be read.
  Claims made elsewhere, and the tails' share, are the owner's commitment; the site shows what reached the reserve.
- Burn-program verification (a public reproducible-build record) is pending until after its deploy; the vault's
  record is not touched.

## Threats considered

Vault drain, keeper misuse, fee-token drain through swaps, harvest-then-withdraw stranding,
one-time claim replays, uninitialized or aliased claim destinations, the creator-rights
window around migration, creator NFTs not moving with a rights transfer, curves that would
migrate into unsupported fee modes, withdrawable principal entering as a "stream",
delegates that survive NFT transfers, duplicate or self-referential streams, forged
own-stream provenance, a dust position posing as a migrated creator position, registration
blocked by unrelated liquidity additions, launches of emptied vaults, pair bindings by
strangers or with prohibitive fees, Token-2022 bases stranding at harvest, orphaned
deduplication indices, stream configs drifting from what the launch path assumes, price
caps no bin can represent, launchpad spam, manufactured income before deposit, stream decay and
non-graduation, bid placement manipulation, settlement griefing, DLMM pair squatting, mint
orientation, order fee denomination, transaction size and compute, rent, Token-2022
extensions, unsolicited tokens, and the upgrade authorities above. Each one has a rule in
the program or a disclosure on the page, and most have a release gate.
