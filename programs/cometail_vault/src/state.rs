//! Account layouts (docs/architecture.md, Accounts). Every foreign account the program reads is checked
//! by owner and discriminator before use; the fields recorded here are the only source of
//! truth the program trusts afterwards.
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Protocol {
    /// Protocol owner's wallet. Can set the keeper, treasury, configs and the routing pause.
    pub admin: Pubkey,
    /// Hot key that may call `route` and keeper-only `settle`.
    pub keeper: Pubkey,
    /// Protocol owner's WSOL token account: receives the 1/5 share of external stream income.
    pub treasury: Pubkey,
    /// DBC partner configs for stream launches, by preset (25 / 50 / 75).
    pub stream_configs: [Pubkey; 3],
    pub paused_routing: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VaultStatus {
    Open,
    Launched,
    Live,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, InitSpace)]
pub struct RoutingPolicy {
    /// Gross WSOL the keeper may place per period.
    pub max_spend_per_period: u64,
    /// Period length in seconds; must be positive.
    pub period_seconds: u64,
    pub max_outstanding_orders: u16,
    /// 1..=50, DLMM's limit.
    pub max_bins_per_order: u8,
    /// Highest price the vault will pay, Q64 lamports per raw stream-token unit, fee-exclusive.
    pub max_price_q64: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, InitSpace)]
pub struct RoutingState {
    pub period_index: u64,
    pub spent_this_period: u64,
    pub outstanding_orders: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, InitSpace)]
pub struct Accounting {
    pub harvested_gross: u64,
    pub to_depositor: u64,
    pub to_protocol: u64,
    pub income: u64,
    pub cashed_out: u64,
    pub routed_gross: u64,
    pub refunded_principal: u64,
    pub order_fees_wsol: u64,
    pub burned_st: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub depositor: Pubkey,
    /// Depositor's WSOL ATA, pinned at creation: the only payout destination.
    pub depositor_wsol: Pubkey,
    pub status: VaultStatus,
    pub preset: u8,
    /// Stream-token mint, generated client-side and bound at `launch`.
    pub st_mint: Pubkey,
    pub st_ata: Pubkey,
    /// The stream token's DBC pool (set at launch) and the DAMM v2 pool it migrates into.
    pub dbc_pool: Pubkey,
    pub damm_pool: Pubkey,
    pub dlmm_pair: Pubkey,
    /// true when the stream token is the pair's token X (bids are bid-side below active).
    pub st_is_x: bool,
    /// Derived from `max_price_q64` at pair registration: an upper bound on bin id when
    /// the stream token is X, a lower bound when it is Y.
    pub bin_bound: i32,
    pub own_position: Pubkey,
    pub own_position_nft_account: Pubkey,
    /// Vault-owned WSOL ATA: harvested income waiting to become bids.
    pub income_wsol: Pubkey,
    /// Second vault-owned WSOL account: the token A destination for every claim. Pinned.
    pub placeholder_wsol: Pubkey,
    pub stream_count: u32,
    pub policy: RoutingPolicy,
    pub routing: RoutingState,
    pub accounting: Accounting,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum StreamKind {
    DbcCreatorRights,
    DammV2Position,
}

#[account]
#[derive(InitSpace)]
pub struct Stream {
    pub vault: Pubkey,
    pub index: u32,
    pub kind: StreamKind,
    /// Set only by `launch` and `register_own_position`. Never from client input.
    pub is_own: bool,
    /// DBC rights: the virtual pool and its config; positions: the DAMM v2 pool.
    pub pool: Pubkey,
    pub config: Pubkey,
    /// DBC rights: the DAMM v2 pool the migration derives to.
    pub derived_damm_pool: Pubkey,
    /// Position (deposited, or the creator position registered after an external migration).
    pub position: Pubkey,
    pub nft_mint: Pubkey,
    pub nft_account: Pubkey,
    /// DBC rights only: bit 0 = migration fee already taken upstream, bit 1 = surplus already taken.
    pub one_time_claims: u8,
    pub deposit_ts: i64,
    pub harvested: u64,
}

/// One per source account (DBC pool, position, NFT mint): nothing is deposited twice.
#[account]
#[derive(InitSpace)]
pub struct StreamIndex {
    pub vault: Pubkey,
    pub stream: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct OrderRecord {
    pub vault: Pubkey,
    pub limit_order: Pubkey,
    pub placed_ts: i64,
    pub gross_spent: u64,
    pub bin_count: u8,
    pub bump: u8,
}
