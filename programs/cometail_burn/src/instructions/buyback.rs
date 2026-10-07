//! Buyback and burn: permissionless. Spends min(reserve, cap) of the reserve on the pinned pool and
//! burns every $COMETAIL received, in one instruction. No amount, price or destination is supplied by
//! the caller; the caller only pays the network fee.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::cp_amm;
use crate::errors::BurnError;
use crate::state::BurnState;

#[derive(Accounts)]
pub struct Buyback<'info> {
    #[account(mut, seeds = [SEED_BURN], bump = burn_state.bump)]
    pub burn_state: Box<Account<'info, BurnState>>,
    #[account(mut, address = burn_state.reserve @ BurnError::AccountMismatch)]
    pub reserve: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = burn_state.bought @ BurnError::AccountMismatch)]
    pub bought: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = burn_state.cometail_mint @ BurnError::AccountMismatch)]
    pub cometail_mint: Box<Account<'info, Mint>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = burn_state.pool @ BurnError::AccountMismatch)]
    pub pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    /// CHECK: DAMM v2 pool authority, by address
    #[account(address = DAMM_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: checked against the pool in the handler (and by the callee)
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: checked against the pool in the handler (and by the callee)
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: DAMM v2 program, by address
    #[account(address = cp_amm::ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 event authority PDA, checked by the callee
    pub cp_amm_event_authority: UncheckedAccount<'info>,
}

/// The chunk cap: pool SOL reserve x fee / CAP_DIVISOR (lamports).
pub fn cap(token_b_amount: u64, fee_numerator: u64) -> Result<u64> {
    let c = (token_b_amount as u128).checked_mul(fee_numerator as u128).ok_or(BurnError::Overflow)?
        / (FEE_DENOMINATOR as u128) / (CAP_DIVISOR as u128);
    u64::try_from(c).map_err(|_| BurnError::Overflow.into())
}

/// The program's own quote for `amount_in` lamports on the compounding pool (fee on the SOL input,
/// rounded up; constant product rounded down, as cp-amm's compounding handler does), less the tolerance.
pub fn min_out(token_a_amount: u64, token_b_amount: u64, amount_in: u64, fee_numerator: u64) -> Result<u64> {
    let fee = (amount_in as u128).checked_mul(fee_numerator as u128).ok_or(BurnError::Overflow)?
        .checked_add(FEE_DENOMINATOR as u128 - 1).ok_or(BurnError::Overflow)? / FEE_DENOMINATOR as u128;
    let net = (amount_in as u128).checked_sub(fee).ok_or(BurnError::Overflow)?;
    let out = (token_a_amount as u128).checked_mul(net).ok_or(BurnError::Overflow)?
        / (token_b_amount as u128).checked_add(net).ok_or(BurnError::Overflow)?;
    let min = out.checked_mul((BPS - MIN_OUT_TOLERANCE_BPS) as u128).ok_or(BurnError::Overflow)? / BPS as u128;
    u64::try_from(min).map_err(|_| BurnError::Overflow.into())
}

pub fn buyback(ctx: Context<Buyback>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let s = &ctx.accounts.burn_state;
    require!(now >= s.last_buy_ts.checked_add(COOLDOWN_SECONDS).ok_or(BurnError::Overflow)?, BurnError::Cooldown);
    let (a_amount, b_amount) = {
        let p = ctx.accounts.pool.load()?;
        require_keys_eq!(p.token_a_mint, s.cometail_mint, BurnError::PoolChanged);
        require_keys_eq!(p.token_b_mint, WSOL_MINT, BurnError::PoolChanged);
        require_keys_eq!(p.token_a_vault, ctx.accounts.token_a_vault.key(), BurnError::AccountMismatch);
        require_keys_eq!(p.token_b_vault, ctx.accounts.token_b_vault.key(), BurnError::AccountMismatch);
        require!(p.collect_fee_mode == DAMM_COLLECT_COMPOUNDING, BurnError::PoolChanged);
        require!(p.pool_status == DAMM_POOL_ENABLED, BurnError::PoolChanged);
        require!(p.pool_fees.dynamic_fee.initialized == 0, BurnError::PoolChanged);
        require!(p.pool_fees.base_fee.base_fee_info.data == s.base_fee_info, BurnError::PoolChanged);
        require!(p.pool_fees.compounding_fee_bps == s.compounding_fee_bps, BurnError::PoolChanged);
        (p.token_a_amount, p.token_b_amount)
    };
    let amount = ctx.accounts.reserve.amount.min(cap(b_amount, s.fee_numerator)?);
    require!(amount >= MIN_BUY_LAMPORTS, BurnError::BelowMinimum);
    let minimum = min_out(a_amount, b_amount, amount, s.fee_numerator)?;
    require!(minimum > 0, BurnError::BelowMinimum);
    let before = ctx.accounts.bought.amount;
    let bump = [s.bump];
    let signer: &[&[u8]] = &[SEED_BURN, &bump];
    cp_amm::cpi::swap(CpiContext::new_with_signer(ctx.accounts.cp_amm_program.key(), cp_amm::cpi::accounts::Swap {
        pool_authority: ctx.accounts.pool_authority.to_account_info(), pool: ctx.accounts.pool.to_account_info(),
        input_token_account: ctx.accounts.reserve.to_account_info(), output_token_account: ctx.accounts.bought.to_account_info(),
        token_a_vault: ctx.accounts.token_a_vault.to_account_info(), token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
        token_a_mint: ctx.accounts.cometail_mint.to_account_info(), token_b_mint: ctx.accounts.wsol_mint.to_account_info(),
        payer: ctx.accounts.burn_state.to_account_info(),
        token_a_program: ctx.accounts.token_program.to_account_info(), token_b_program: ctx.accounts.token_program.to_account_info(),
        referral_token_account: None,
        event_authority: ctx.accounts.cp_amm_event_authority.to_account_info(), program: ctx.accounts.cp_amm_program.to_account_info(),
    }, &[signer]), cp_amm::types::SwapParameters { amount_in: amount, minimum_amount_out: minimum })?;
    ctx.accounts.bought.reload()?;
    let received = ctx.accounts.bought.amount.checked_sub(before).ok_or(BurnError::Overflow)?;
    require!(received >= minimum, BurnError::SlippageExceeded);
    // everything in the account is burned: what this swap delivered and anything sent to it before
    let burn_amount = ctx.accounts.bought.amount;
    token::burn(CpiContext::new_with_signer(ctx.accounts.token_program.key(), Burn {
        mint: ctx.accounts.cometail_mint.to_account_info(), from: ctx.accounts.bought.to_account_info(), authority: ctx.accounts.burn_state.to_account_info(),
    }, &[signer]), burn_amount)?;
    let s = &mut ctx.accounts.burn_state;
    s.spent_total = s.spent_total.checked_add(amount).ok_or(BurnError::Overflow)?;
    s.burned_total = s.burned_total.checked_add(burn_amount).ok_or(BurnError::Overflow)?;
    s.buybacks = s.buybacks.checked_add(1).ok_or(BurnError::Overflow)?;
    s.last_buy_ts = now;
    emit!(BuybackBurned { spent: amount, received, burned: burn_amount, min_out: minimum, pool_sol_before: b_amount, pool_cometail_before: a_amount, ts: now });
    Ok(())
}

#[event]
pub struct BuybackBurned { pub spent: u64, pub received: u64, pub burned: u64, pub min_out: u64, pub pool_sol_before: u64, pub pool_cometail_before: u64, pub ts: i64 }
