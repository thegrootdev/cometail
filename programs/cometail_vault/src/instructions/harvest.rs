use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use anchor_spl::token_interface::{TokenAccount as TokenAccountIf, TokenInterface};

use crate::constants::*;
use crate::cp_amm;
use crate::dynamic_bonding_curve as dbc;
use crate::errors::VaultError;
use crate::instructions::eligibility::*;
use crate::state::*;

fn vault_signer(vault: &Vault) -> [Vec<u8>; 3] { [SEED_VAULT.to_vec(), vault.st_mint.to_bytes().to_vec(), vec![vault.bump]] }

/// Split a fresh claim delta: the depositor's or protocol's share leaves the income account
/// in the same instruction; rounding dust stays as income. Returns (to_depositor, to_protocol).
fn split_and_pay<'info>(
    vault: &Account<'info, Vault>,
    stream: &Stream,
    gross: u64,
    income: &AccountInfo<'info>,
    depositor_wsol: &AccountInfo<'info>,
    treasury: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<(u64, u64)> {
    let (num, den, to_depositor) = match (stream.is_own, stream.kind) {
        (true, StreamKind::DbcCreatorRights) => (OWN_CURVE_DEPOSITOR_NUM, OWN_CURVE_DEPOSITOR_DEN, true),
        (true, StreamKind::DammV2Position) => (OWN_POSITION_DEPOSITOR_NUM, OWN_POSITION_DEPOSITOR_DEN, true),
        (false, _) => (EXTERNAL_PROTOCOL_NUM, EXTERNAL_PROTOCOL_DEN, false),
    };
    let share = (gross as u128).checked_mul(num as u128).ok_or(VaultError::Overflow)? / den as u128;
    let share = share as u64;
    if share == 0 { return Ok((0, 0)); }
    let seeds = vault_signer(vault);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    let to = if to_depositor { depositor_wsol } else { treasury };
    token::transfer(CpiContext::new_with_signer(token_program.key(), token::Transfer { from: income.clone(), to: to.clone(), authority: vault.to_account_info() }, &[signer]), share)?;
    Ok(if to_depositor { (share, 0) } else { (0, share) })
}

fn book(vault: &mut Vault, stream: &mut Stream, gross: u64, to_depositor: u64, to_protocol: u64) -> Result<()> {
    let a = &mut vault.accounting;
    a.harvested_gross = a.harvested_gross.checked_add(gross).ok_or(VaultError::Overflow)?;
    a.to_depositor = a.to_depositor.checked_add(to_depositor).ok_or(VaultError::Overflow)?;
    a.to_protocol = a.to_protocol.checked_add(to_protocol).ok_or(VaultError::Overflow)?;
    a.income = a.income.checked_add(gross.checked_sub(to_depositor).and_then(|x| x.checked_sub(to_protocol)).ok_or(VaultError::Overflow)?).ok_or(VaultError::Overflow)?;
    stream.harvested = stream.harvested.checked_add(gross).ok_or(VaultError::Overflow)?;
    Ok(())
}

/// Common pinned accounts for every harvest.
#[derive(Accounts)]
pub struct HarvestCommon<'info> {
    #[account(seeds = [SEED_PROTOCOL], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, has_one = vault @ VaultError::AccountMismatch)]
    pub stream: Box<Account<'info, Stream>>,
    #[account(mut, constraint = income_wsol.key() == vault.income_wsol @ VaultError::AccountMismatch)]
    pub income_wsol: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = placeholder_wsol.key() == vault.placeholder_wsol @ VaultError::AccountMismatch)]
    pub placeholder_wsol: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = depositor_wsol.key() == vault.depositor_wsol @ VaultError::AccountMismatch)]
    pub depositor_wsol: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = treasury.key() == protocol.treasury @ VaultError::AccountMismatch)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------------------
// harvest_dbc: creator trading fees of a DBC pool (own or deposited), quote only
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct HarvestDbc<'info> {
    pub common: HarvestCommon<'info>,
    #[account(mut, constraint = dbc_pool.key() == common.stream.pool @ VaultError::AccountMismatch)]
    pub dbc_pool: AccountLoader<'info, dbc::accounts::VirtualPool>,
    /// CHECK: DBC pool authority, by address
    #[account(address = DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: the pool's base vault, checked against the pool
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's quote vault, checked against the pool
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's base mint, checked against the pool
    pub base_mint: UncheckedAccount<'info>,
    /// The base mint's own token program (SPL or Token-2022): DBC constrains the base vault to it.
    #[account(constraint = base_token_program.key() == *base_mint.owner @ VaultError::AccountMismatch)]
    pub base_token_program: Interface<'info, TokenInterface>,
    /// CHECK: DBC program, by address
    #[account(address = dbc::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: DBC event authority PDA, checked by the callee
    pub dbc_event_authority: UncheckedAccount<'info>,
}

pub fn harvest_dbc(ctx: Context<HarvestDbc>) -> Result<()> {
    let c = &ctx.accounts.common;
    require!(c.vault.status != VaultStatus::Open, VaultError::WrongStatus);
    require!(c.stream.kind == StreamKind::DbcCreatorRights, VaultError::AccountMismatch);
    let (base_vault, quote_vault, base_mint) = {
        let p = ctx.accounts.dbc_pool.load()?;
        require_keys_eq!(p.pool_state.creator, c.vault.key(), VaultError::AccountMismatch);
        (p.pool_state.base_vault, p.pool_state.quote_vault, p.pool_state.base_mint)
    };
    require_keys_eq!(ctx.accounts.base_vault.key(), base_vault, VaultError::AccountMismatch);
    require_keys_eq!(ctx.accounts.quote_vault.key(), quote_vault, VaultError::AccountMismatch);
    require_keys_eq!(ctx.accounts.base_mint.key(), base_mint, VaultError::AccountMismatch);
    let before = c.income_wsol.amount;
    let seeds = vault_signer(&c.vault);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    // quote only: max_base = 0 (fees are collected in quote by eligibility), token A destination is the placeholder
    dbc::cpi::claim_creator_trading_fee(CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), dbc::cpi::accounts::ClaimCreatorTradingFee {
        pool_authority: ctx.accounts.dbc_pool_authority.to_account_info(), pool: ctx.accounts.dbc_pool.to_account_info(),
        token_a_account: c.placeholder_wsol.to_account_info(), token_b_account: c.income_wsol.to_account_info(),
        base_vault: ctx.accounts.base_vault.to_account_info(), quote_vault: ctx.accounts.quote_vault.to_account_info(),
        base_mint: ctx.accounts.base_mint.to_account_info(), quote_mint: c.wsol_mint.to_account_info(), creator: c.vault.to_account_info(),
        token_base_program: ctx.accounts.base_token_program.to_account_info(), token_quote_program: c.token_program.to_account_info(),
        event_authority: ctx.accounts.dbc_event_authority.to_account_info(), program: ctx.accounts.dbc_program.to_account_info(),
    }, &[signer]), 0, u64::MAX)?;
    finish(&mut ctx.accounts.common, before)
}

// ---------------------------------------------------------------------------------------
// harvest_position: DAMM v2 position fees (own or deposited), token B only
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct HarvestPosition<'info> {
    pub common: HarvestCommon<'info>,
    /// The stream's DAMM v2 pool: the deposited pool for position streams, the migration's
    /// derived pool for DBC-rights streams (both record it in `derived_damm_pool`).
    #[account(constraint = damm_pool.key() == common.stream.derived_damm_pool @ VaultError::AccountMismatch)]
    pub damm_pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    #[account(mut, constraint = position.key() == common.stream.position @ VaultError::AccountMismatch, constraint = position.load()?.pool == damm_pool.key() @ VaultError::AccountMismatch)]
    pub position: AccountLoader<'info, cp_amm::accounts::Position>,
    #[account(constraint = nft_account.key() == common.stream.nft_account @ VaultError::AccountMismatch)]
    pub nft_account: Box<InterfaceAccount<'info, TokenAccountIf>>,
    /// CHECK: DAMM v2 pool authority, checked by the callee
    pub cp_amm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: checked against the pool
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: checked against the pool
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: checked against the pool
    pub token_a_mint: UncheckedAccount<'info>,
    /// Token A's own token program (SPL or Token-2022): cp-amm constrains the A vault to it.
    #[account(constraint = token_a_program.key() == *token_a_mint.owner @ VaultError::AccountMismatch)]
    pub token_a_program: Interface<'info, TokenInterface>,
    /// CHECK: DAMM v2 program, by address
    #[account(address = cp_amm::ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 event authority PDA, checked by the callee
    pub cp_amm_event_authority: UncheckedAccount<'info>,
}

pub fn harvest_position(ctx: Context<HarvestPosition>) -> Result<()> {
    let c = &ctx.accounts.common;
    require!(c.vault.status != VaultStatus::Open, VaultError::WrongStatus);
    require!(c.stream.position != Pubkey::default(), VaultError::AccountMismatch);
    let (a_vault, b_vault, a_mint) = {
        let p = ctx.accounts.damm_pool.load()?;
        require!(p.collect_fee_mode == DAMM_COLLECT_ONLY_B || p.collect_fee_mode == DAMM_COLLECT_COMPOUNDING, VaultError::Ineligible);
        (p.token_a_vault, p.token_b_vault, p.token_a_mint)
    };
    require_keys_eq!(ctx.accounts.token_a_vault.key(), a_vault, VaultError::AccountMismatch);
    require_keys_eq!(ctx.accounts.token_b_vault.key(), b_vault, VaultError::AccountMismatch);
    require_keys_eq!(ctx.accounts.token_a_mint.key(), a_mint, VaultError::AccountMismatch);
    let before = c.income_wsol.amount;
    let seeds = vault_signer(&c.vault);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    cp_amm::cpi::claim_position_fee(CpiContext::new_with_signer(ctx.accounts.cp_amm_program.key(), cp_amm::cpi::accounts::ClaimPositionFee {
        pool_authority: ctx.accounts.cp_amm_pool_authority.to_account_info(), pool: ctx.accounts.damm_pool.to_account_info(), position: ctx.accounts.position.to_account_info(),
        token_a_account: c.placeholder_wsol.to_account_info(), token_b_account: c.income_wsol.to_account_info(),
        token_a_vault: ctx.accounts.token_a_vault.to_account_info(), token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
        token_a_mint: ctx.accounts.token_a_mint.to_account_info(), token_b_mint: c.wsol_mint.to_account_info(),
        position_nft_account: ctx.accounts.nft_account.to_account_info(), signer: c.vault.to_account_info(),
        token_a_program: ctx.accounts.token_a_program.to_account_info(), token_b_program: c.token_program.to_account_info(),
        event_authority: ctx.accounts.cp_amm_event_authority.to_account_info(), program: ctx.accounts.cp_amm_program.to_account_info(),
    }, &[signer]))?;
    finish(&mut ctx.accounts.common, before)
}

// ---------------------------------------------------------------------------------------
// harvest_one_time: a deposited DBC pool's creator migration fee and surplus, each once
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct HarvestOneTime<'info> {
    pub common: HarvestCommon<'info>,
    #[account(mut, constraint = dbc_pool.key() == common.stream.pool @ VaultError::AccountMismatch)]
    pub dbc_pool: AccountLoader<'info, dbc::accounts::VirtualPool>,
    /// CHECK: checked against the stream
    #[account(constraint = dbc_config.key() == common.stream.config @ VaultError::AccountMismatch)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: DBC pool authority, by address
    #[account(address = DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: checked against the pool
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: DBC program, by address
    #[account(address = dbc::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: DBC event authority PDA, checked by the callee
    pub dbc_event_authority: UncheckedAccount<'info>,
}

pub fn harvest_one_time(ctx: Context<HarvestOneTime>) -> Result<()> {
    let c = &ctx.accounts.common;
    require!(c.vault.status != VaultStatus::Open, VaultError::WrongStatus);
    require!(c.stream.kind == StreamKind::DbcCreatorRights && !c.stream.is_own, VaultError::AccountMismatch);
    let (fee_pending, surplus_pending) = {
        let p = ctx.accounts.dbc_pool.load()?;
        require_keys_eq!(p.pool_state.creator, c.vault.key(), VaultError::AccountMismatch);
        require_keys_eq!(p.pool_state.quote_vault, ctx.accounts.quote_vault.key(), VaultError::AccountMismatch);
        let done = p.pool_state.migration_progress != DBC_PROGRESS_PRE_BONDING;
        (done && p.pool_state.migration_fee_withdraw_status & DBC_CREATOR_MIGRATION_FEE_MASK == 0, done && p.pool_state.is_creator_withdraw_surplus == 0)
    };
    require!(fee_pending || surplus_pending, VaultError::WrongStatus);
    let before = c.income_wsol.amount;
    let seeds = vault_signer(&c.vault);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    if fee_pending {
        dbc::cpi::withdraw_migration_fee(CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), dbc::cpi::accounts::WithdrawMigrationFee {
            pool_authority: ctx.accounts.dbc_pool_authority.to_account_info(), config: ctx.accounts.dbc_config.to_account_info(), virtual_pool: ctx.accounts.dbc_pool.to_account_info(),
            token_quote_account: c.income_wsol.to_account_info(), quote_vault: ctx.accounts.quote_vault.to_account_info(), quote_mint: c.wsol_mint.to_account_info(),
            sender: c.vault.to_account_info(), token_quote_program: c.token_program.to_account_info(), event_authority: ctx.accounts.dbc_event_authority.to_account_info(), program: ctx.accounts.dbc_program.to_account_info(),
        }, &[signer]), 1)?;
    }
    if surplus_pending {
        dbc::cpi::creator_withdraw_surplus(CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), dbc::cpi::accounts::CreatorWithdrawSurplus {
            pool_authority: ctx.accounts.dbc_pool_authority.to_account_info(), config: ctx.accounts.dbc_config.to_account_info(), virtual_pool: ctx.accounts.dbc_pool.to_account_info(),
            token_quote_account: c.income_wsol.to_account_info(), quote_vault: ctx.accounts.quote_vault.to_account_info(), quote_mint: c.wsol_mint.to_account_info(),
            creator: c.vault.to_account_info(), token_quote_program: c.token_program.to_account_info(), event_authority: ctx.accounts.dbc_event_authority.to_account_info(), program: ctx.accounts.dbc_program.to_account_info(),
        }, &[signer]))?;
    }
    let common = &mut ctx.accounts.common;
    common.stream.one_time_claims |= (fee_pending as u8) | ((surplus_pending as u8) << 1);
    finish(common, before)
}

fn finish(c: &mut HarvestCommon, before: u64) -> Result<()> {
    c.income_wsol.reload()?;
    let gross = c.income_wsol.amount.checked_sub(before).ok_or(VaultError::Overflow)?;
    let (to_depositor, to_protocol) = split_and_pay(&c.vault, &c.stream, gross, &c.income_wsol.to_account_info(), &c.depositor_wsol.to_account_info(), &c.treasury.to_account_info(), &c.token_program.to_account_info())?;
    let vault_key = c.vault.key();
    let stream_key = c.stream.key();
    book(&mut c.vault, &mut c.stream, gross, to_depositor, to_protocol)?;
    emit!(Harvested { vault: vault_key, stream: stream_key, gross, to_depositor, to_protocol, to_income: gross - to_depositor - to_protocol });
    Ok(())
}

#[event] pub struct Harvested { pub vault: Pubkey, pub stream: Pubkey, pub gross: u64, pub to_depositor: u64, pub to_protocol: u64, pub to_income: u64 }
