//! Setup: once, by this program's upgrade authority. Pins the $COMETAIL mint, its DAMM v2 pool (and
//! that pool's fee settings), the protocol treasury, and creates the program-owned token accounts.
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::cp_amm;
use crate::errors::BurnError;
use crate::state::BurnState;

#[derive(Accounts)]
pub struct Setup<'info> {
    #[account(init, payer = authority, space = 8 + BurnState::INIT_SPACE, seeds = [SEED_BURN], bump)]
    pub burn_state: Box<Account<'info, BurnState>>,
    /// The upgrade authority of THIS program, bound through its ProgramData: the first-caller
    /// takeover between deployment and setup is closed. It also pays the rent.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ BurnError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::CometailBurn>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ BurnError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    /// CHECK: the fee-claimer PDA new launch configs name; signs Meteora claims, holds nothing
    #[account(seeds = [SEED_CLAIMER], bump)]
    pub claimer: UncheckedAccount<'info>,
    #[account(constraint = *cometail_mint.to_account_info().owner == Token::id() @ BurnError::PoolNotEligible)]
    pub cometail_mint: Box<Account<'info, Mint>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    /// The protocol treasury: a WSOL account of the classic token program. Only ever paid into.
    #[account(constraint = treasury.mint == WSOL_MINT @ BurnError::AccountMismatch)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = authority, seeds = [SEED_RESERVE], bump, token::mint = wsol_mint, token::authority = burn_state)]
    pub reserve: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = authority, seeds = [SEED_INBOX], bump, token::mint = wsol_mint, token::authority = burn_state)]
    pub inbox: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = authority, seeds = [SEED_PLACEHOLDER], bump, token::mint = wsol_mint, token::authority = burn_state)]
    pub placeholder: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = authority, seeds = [SEED_BOUGHT], bump, token::mint = cometail_mint, token::authority = burn_state)]
    pub bought: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// The pool must be the $COMETAIL/SOL compounding pool with a constant fee of at least 1%: base fee
/// data is the cliff numerator followed by zeros (no scheduler periods, no rate limiter), no dynamic fee.
pub fn eligible_fee(base_fee_info: &[u8; 32]) -> Option<u64> {
    let cliff = u64::from_le_bytes(base_fee_info[..8].try_into().ok()?);
    if cliff < MIN_FEE_NUMERATOR || base_fee_info[8..].iter().any(|b| *b != 0) { return None; }
    Some(cliff)
}

pub fn setup(ctx: Context<Setup>) -> Result<()> {
    let (base_fee_info, compounding_fee_bps) = {
        let p = ctx.accounts.pool.load()?;
        require_keys_eq!(p.token_a_mint, ctx.accounts.cometail_mint.key(), BurnError::PoolNotEligible);
        require_keys_eq!(p.token_b_mint, WSOL_MINT, BurnError::PoolNotEligible);
        require!(p.collect_fee_mode == DAMM_COLLECT_COMPOUNDING, BurnError::PoolNotEligible);
        require!(p.pool_status == DAMM_POOL_ENABLED, BurnError::PoolNotEligible);
        require!(p.pool_fees.dynamic_fee.initialized == 0, BurnError::PoolNotEligible);
        (p.pool_fees.base_fee.base_fee_info.data, p.pool_fees.compounding_fee_bps)
    };
    let fee_numerator = eligible_fee(&base_fee_info).ok_or(BurnError::PoolNotEligible)?;
    let (authority, mint, pool, treasury, reserve, inbox, placeholder, bought, claimer) = {
        let a = &ctx.accounts;
        (a.authority.key(), a.cometail_mint.key(), a.pool.key(), a.treasury.key(), a.reserve.key(), a.inbox.key(), a.placeholder.key(), a.bought.key(), a.claimer.key())
    };
    let s = &mut ctx.accounts.burn_state;
    s.setup_by = authority;
    s.cometail_mint = mint;
    s.pool = pool;
    s.treasury = treasury;
    s.reserve = reserve;
    s.inbox = inbox;
    s.placeholder = placeholder;
    s.bought = bought;
    s.base_fee_info = base_fee_info;
    s.compounding_fee_bps = compounding_fee_bps;
    s.fee_numerator = fee_numerator;
    s.bump = ctx.bumps.burn_state;
    s.claimer_bump = ctx.bumps.claimer;
    emit!(BurnSetup { pool, cometail_mint: mint, treasury, reserve, claimer, fee_numerator });
    Ok(())
}

#[event]
pub struct BurnSetup { pub pool: Pubkey, pub cometail_mint: Pubkey, pub treasury: Pubkey, pub reserve: Pubkey, pub claimer: Pubkey, pub fee_numerator: u64 }
