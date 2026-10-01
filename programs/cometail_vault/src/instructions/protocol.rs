use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::Token;
use anchor_spl::token_interface::TokenAccount;

use crate::constants::*;
use crate::dynamic_bonding_curve as dbc;
use crate::errors::VaultError;
use crate::instructions::eligibility::*;
use crate::state::*;

/// The protocol owner's treasury is the owner's legacy-SPL WSOL associated token account:
/// derived, not supplied.
fn check_treasury(treasury: &InterfaceAccount<TokenAccount>, treasury_info: &AccountInfo, admin: &Pubkey) -> Result<()> {
    require_keys_eq!(*treasury_info.owner, Token::id(), VaultError::AccountMismatch);
    require_keys_eq!(treasury.mint, WSOL_MINT, VaultError::AccountMismatch);
    require_keys_eq!(treasury.owner, *admin, VaultError::AccountMismatch);
    require_keys_eq!(treasury_info.key(), get_associated_token_address(admin, &WSOL_MINT), VaultError::AccountMismatch);
    Ok(())
}

/// A stream config: a real DBC config owned by the protocol owner, with the locked
/// economics for its preset (docs/economics.md). Gate 12 covers the full parameter set.
pub fn check_stream_config(info: &AccountInfo, admin: &Pubkey, preset: usize) -> Result<()> {
    require_keys_eq!(*info.owner, dbc::ID, VaultError::ForeignAccount);
    let data = info.try_borrow_data()?;
    let disc = <dbc::accounts::PoolConfig as anchor_lang::Discriminator>::DISCRIMINATOR;
    let size = core::mem::size_of::<dbc::accounts::PoolConfig>();
    require!(data.len() >= 8 + size && data[..8] == *disc, VaultError::ForeignAccount);
    let c: &dbc::accounts::PoolConfig = bytemuck::from_bytes(&data[8..8 + size]);
    require_keys_eq!(c.fee_claimer, *admin, VaultError::AccountMismatch);
    require_keys_eq!(c.quote_mint, WSOL_MINT, VaultError::Ineligible);
    require!(c.collect_fee_mode == DBC_COLLECT_QUOTE, VaultError::Ineligible);
    require!(c.migration_option == DBC_MIGRATION_DAMM_V2, VaultError::Ineligible);
    require!(c.migrated_collect_fee_mode == DBC_MIGRATED_COMPOUNDING, VaultError::Ineligible);
    require!(c.creator_trading_fee_percentage == 75, VaultError::Ineligible);
    require!(c.creator_permanent_locked_liquidity_percentage == 80 && c.partner_permanent_locked_liquidity_percentage == 20, VaultError::Ineligible);
    require!(c.creator_liquidity_percentage == 0 && c.partner_liquidity_percentage == 0, VaultError::Ineligible);
    let expected_fee = [25u8, 50, 75][preset];
    require!(c.migration_fee_percentage == expected_fee && c.creator_migration_fee_percentage == 100, VaultError::Ineligible);
    Ok(())
}

#[derive(Accounts)]
pub struct InitProtocol<'info> {
    #[account(init, payer = payer, space = 8 + Protocol::INIT_SPACE, seeds = [SEED_PROTOCOL], bump)]
    pub protocol: Account<'info, Protocol>,
    /// The program's upgrade authority. Only it can claim the singleton: the first-caller
    /// takeover between deployment and initialization is closed by binding the admin to the
    /// executable's own ProgramData.
    pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ VaultError::NotAdmin)]
    pub program: Program<'info, crate::program::CometailVault>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ VaultError::NotAdmin)]
    pub program_data: Account<'info, ProgramData>,
    /// CHECK: hot key; only ever compared by key.
    pub keeper: UncheckedAccount<'info>,
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: DBC config for the 25% preset, validated in the handler
    pub config_25: UncheckedAccount<'info>,
    /// CHECK: DBC config for the 50% preset, validated in the handler
    pub config_50: UncheckedAccount<'info>,
    /// CHECK: DBC config for the 75% preset, validated in the handler
    pub config_75: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_protocol(ctx: Context<InitProtocol>) -> Result<()> {
    let admin = ctx.accounts.admin.key();
    check_treasury(&ctx.accounts.treasury, &ctx.accounts.treasury.to_account_info(), &admin)?;
    let configs = [&ctx.accounts.config_25, &ctx.accounts.config_50, &ctx.accounts.config_75];
    for (i, c) in configs.iter().enumerate() { check_stream_config(&c.to_account_info(), &admin, i)?; }
    let p = &mut ctx.accounts.protocol;
    p.admin = admin;
    p.keeper = ctx.accounts.keeper.key();
    p.treasury = ctx.accounts.treasury.key();
    p.stream_configs = [configs[0].key(), configs[1].key(), configs[2].key()];
    p.paused_routing = false;
    p.bump = ctx.bumps.protocol;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateProtocol<'info> {
    #[account(mut, seeds = [SEED_PROTOCOL], bump = protocol.bump, has_one = admin @ VaultError::NotAdmin)]
    pub protocol: Account<'info, Protocol>,
    pub admin: Signer<'info>,
    /// CHECK: new keeper, only compared by key (optional)
    pub keeper: Option<UncheckedAccount<'info>>,
    /// New treasury: still the admin's WSOL ATA (optional; validated)
    pub treasury: Option<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: new 25% config (optional; validated)
    pub config_25: Option<UncheckedAccount<'info>>,
    /// CHECK: new 50% config (optional; validated)
    pub config_50: Option<UncheckedAccount<'info>>,
    /// CHECK: new 75% config (optional; validated)
    pub config_75: Option<UncheckedAccount<'info>>,
}

pub fn update_protocol(ctx: Context<UpdateProtocol>, paused_routing: Option<bool>) -> Result<()> {
    let admin = ctx.accounts.admin.key();
    let p = &mut ctx.accounts.protocol;
    if let Some(k) = &ctx.accounts.keeper { p.keeper = k.key(); }
    if let Some(t) = &ctx.accounts.treasury {
        check_treasury(t, &t.to_account_info(), &admin)?;
        p.treasury = t.key();
    }
    let new = [&ctx.accounts.config_25, &ctx.accounts.config_50, &ctx.accounts.config_75];
    for (i, c) in new.iter().enumerate() {
        if let Some(c) = c {
            check_stream_config(&c.to_account_info(), &admin, i)?;
            p.stream_configs[i] = c.key();
        }
    }
    if let Some(x) = paused_routing { p.paused_routing = x; }
    Ok(())
}
