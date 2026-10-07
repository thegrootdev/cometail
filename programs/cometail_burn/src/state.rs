//! The singleton. Every pinned key is set once at setup; the totals only grow.
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct BurnState {
    /// The upgrade authority that ran setup (a record; it holds no power here).
    pub setup_by: Pubkey,
    pub cometail_mint: Pubkey,
    /// The $COMETAIL/SOL DAMM v2 pool every buyback trades on ($COMETAIL is token A, SOL token B).
    pub pool: Pubkey,
    /// Protocol treasury (a WSOL token account): receives the other half of every split.
    pub treasury: Pubkey,
    /// Program-owned WSOL accounts: the burn reserve, the claim inbox, the token-A placeholder.
    pub reserve: Pubkey,
    pub inbox: Pubkey,
    pub placeholder: Pubkey,
    /// Program-owned $COMETAIL account: what a buyback receives, burned in the same instruction.
    pub bought: Pubkey,
    /// The pool's fee settings at setup; every buyback requires them unchanged.
    pub base_fee_info: [u8; 32],
    pub compounding_fee_bps: u16,
    pub fee_numerator: u64,
    /// Totals, in lamports and raw $COMETAIL units.
    pub split_total: u64,
    pub split_to_reserve: u64,
    pub split_to_treasury: u64,
    pub spent_total: u64,
    pub burned_total: u64,
    pub buybacks: u64,
    pub last_buy_ts: i64,
    pub bump: u8,
    pub claimer_bump: u8,
}
