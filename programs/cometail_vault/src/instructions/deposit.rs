use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::cp_amm;
use crate::dynamic_bonding_curve as dbc;
use crate::errors::VaultError;
use crate::instructions::eligibility::*;
use crate::state::*;

fn open_vault_by_depositor(vault: &Vault, depositor: &Pubkey) -> Result<()> {
    require!(vault.status == VaultStatus::Open, VaultError::WrongStatus);
    require_keys_eq!(vault.depositor, *depositor, VaultError::NotDepositor);
    Ok(())
}

/// Clear persistent delegate bits on a position the vault now owns (owner-signed CPI).
pub fn clear_delegate_permission<'info>(
    vault: &Account<'info, Vault>,
    position: &AccountInfo<'info>,
    nft_account: &AccountInfo<'info>,
    cp_amm_program: &AccountInfo<'info>,
    event_authority: &AccountInfo<'info>,
) -> Result<()> {
    let st_mint = vault.st_mint;
    let seeds: &[&[u8]] = &[SEED_VAULT, st_mint.as_ref(), &[vault.bump]];
    cp_amm::cpi::update_delegate_permission(
        CpiContext::new_with_signer(
            cp_amm_program.key(),
            cp_amm::cpi::accounts::UpdateDelegatePermission {
                position: position.clone(),
                position_nft_account: nft_account.clone(),
                owner: vault.to_account_info(),
                event_authority: event_authority.clone(),
                program: cp_amm_program.clone(),
            },
            &[seeds],
        ),
        0,
    )
}

/// One more open stream on the vault: the launch gate counts these, withdrawals take them back.
pub fn add_active_stream(vault: &mut Vault) -> Result<()> {
    vault.active_streams = vault.active_streams.checked_add(1).ok_or(VaultError::Overflow)?;
    vault.stream_count = vault.stream_count.checked_add(1).ok_or(VaultError::Overflow)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// deposit_position: a DAMM v2 position NFT already transferred into a vault-owned account
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct DepositPosition<'info> {
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(init, payer = depositor, space = 8 + Stream::INIT_SPACE, seeds = [SEED_STREAM, vault.key().as_ref(), &vault.stream_count.to_le_bytes()], bump)]
    pub stream: Account<'info, Stream>,
    /// One per position: a position can only ever be deposited once.
    #[account(init, payer = depositor, space = 8 + StreamIndex::INIT_SPACE, seeds = [SEED_STREAM_INDEX, position.key().as_ref()], bump)]
    pub stream_index: Account<'info, StreamIndex>,
    pub damm_pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    #[account(mut, constraint = position.load()?.pool == damm_pool.key() @ VaultError::AccountMismatch)]
    pub position: AccountLoader<'info, cp_amm::accounts::Position>,
    #[account(constraint = nft_mint.key() == position.load()?.nft_mint @ VaultError::AccountMismatch)]
    pub nft_mint: Box<InterfaceAccount<'info, Mint>>,
    pub nft_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: read as a mint of either token program inside the eligibility routine
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 program, by address
    #[account(address = cp_amm::ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 event authority PDA, checked by the callee
    pub cp_amm_event_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_position(ctx: Context<DepositPosition>) -> Result<()> {
    open_vault_by_depositor(&ctx.accounts.vault, &ctx.accounts.depositor.key())?;
    let pool = ctx.accounts.damm_pool.load()?;
    check_damm_pool(&pool, &ctx.accounts.base_mint.to_account_info())?;
    let pos = ctx.accounts.position.load()?;
    check_position_principal(&pos)?;
    check_nft_account(&ctx.accounts.nft_account, &ctx.accounts.vault.key(), &pos.nft_mint)?;
    require_keys_neq!(ctx.accounts.position.key(), ctx.accounts.vault.own_position, VaultError::Duplicate);
    let nft_mint = pos.nft_mint;
    drop(pos);
    drop(pool);
    clear_delegate_permission(
        &ctx.accounts.vault,
        &ctx.accounts.position.to_account_info(),
        &ctx.accounts.nft_account.to_account_info(),
        &ctx.accounts.cp_amm_program.to_account_info(),
        &ctx.accounts.cp_amm_event_authority.to_account_info(),
    )?;
    let vault = &mut ctx.accounts.vault;
    let s = &mut ctx.accounts.stream;
    s.vault = vault.key();
    s.index = vault.stream_count;
    s.kind = StreamKind::DammV2Position;
    s.is_own = false;
    s.pool = ctx.accounts.damm_pool.key();
    s.config = Pubkey::default();
    s.derived_damm_pool = ctx.accounts.damm_pool.key();
    s.position = ctx.accounts.position.key();
    s.nft_mint = nft_mint;
    s.nft_account = ctx.accounts.nft_account.key();
    s.one_time_claims = 0;
    s.deposit_ts = Clock::get()?.unix_timestamp;
    ctx.accounts.stream_index.vault = vault.key();
    ctx.accounts.stream_index.stream = s.key();
    add_active_stream(vault)?;
    emit!(StreamDeposited { vault: vault.key(), stream: s.key(), kind: 1, pool: s.pool, position: s.position });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// deposit_dbc_rights: pool.creator already moved to the vault in this transaction; the curve
// is still open (PreBondingCurve), so no creator position exists yet. It registers later
// through register_stream_position.
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct DepositDbcRights<'info> {
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(init, payer = depositor, space = 8 + Stream::INIT_SPACE, seeds = [SEED_STREAM, vault.key().as_ref(), &vault.stream_count.to_le_bytes()], bump)]
    pub stream: Account<'info, Stream>,
    #[account(init, payer = depositor, space = 8 + StreamIndex::INIT_SPACE, seeds = [SEED_STREAM_INDEX, dbc_pool.key().as_ref()], bump)]
    pub stream_index: Account<'info, StreamIndex>,
    pub dbc_pool: AccountLoader<'info, dbc::accounts::VirtualPool>,
    pub dbc_config: AccountLoader<'info, dbc::accounts::PoolConfig>,
    /// CHECK: read as a mint of either token program inside the eligibility routine
    pub base_mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_dbc_rights(ctx: Context<DepositDbcRights>) -> Result<()> {
    open_vault_by_depositor(&ctx.accounts.vault, &ctx.accounts.depositor.key())?;
    require_keys_neq!(ctx.accounts.dbc_pool.key(), ctx.accounts.vault.dbc_pool, VaultError::Duplicate);
    let pool = ctx.accounts.dbc_pool.load()?;
    let config = ctx.accounts.dbc_config.load()?;
    let elig = check_dbc_rights(&pool.pool_state, &ctx.accounts.dbc_config.key(), &config, &ctx.accounts.base_mint.to_account_info(), &ctx.accounts.vault.key())?;
    require!(elig.migration_progress == DBC_PROGRESS_PRE_BONDING, VaultError::WrongStatus);
    drop(pool);
    drop(config);
    let vault = &mut ctx.accounts.vault;
    let s = &mut ctx.accounts.stream;
    s.vault = vault.key();
    s.index = vault.stream_count;
    s.kind = StreamKind::DbcCreatorRights;
    s.is_own = false;
    s.pool = ctx.accounts.dbc_pool.key();
    s.config = ctx.accounts.dbc_config.key();
    s.derived_damm_pool = elig.derived_damm_pool;
    s.position = Pubkey::default();
    s.nft_mint = Pubkey::default();
    s.nft_account = Pubkey::default();
    s.one_time_claims = elig.one_time_claims;
    s.deposit_ts = Clock::get()?.unix_timestamp;
    ctx.accounts.stream_index.vault = vault.key();
    ctx.accounts.stream_index.stream = s.key();
    add_active_stream(vault)?;
    emit!(StreamDeposited { vault: vault.key(), stream: s.key(), kind: 0, pool: s.pool, position: s.position });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// deposit_dbc_rights_migrated: the pool already graduated (CreatedPool). The rights come
// with the creator position, whose NFT the depositor handed to the vault with a Token-2022
// SetAuthority on cp-amm's own PDA account for it. The position gets its own StreamIndex so
// it can never enter again as a standalone stream.
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct DepositDbcRightsMigrated<'info> {
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(init, payer = depositor, space = 8 + Stream::INIT_SPACE, seeds = [SEED_STREAM, vault.key().as_ref(), &vault.stream_count.to_le_bytes()], bump)]
    pub stream: Box<Account<'info, Stream>>,
    #[account(init, payer = depositor, space = 8 + StreamIndex::INIT_SPACE, seeds = [SEED_STREAM_INDEX, dbc_pool.key().as_ref()], bump)]
    pub stream_index: Box<Account<'info, StreamIndex>>,
    /// Index of the bundled creator position: the position can never be deposited again.
    #[account(init, payer = depositor, space = 8 + StreamIndex::INIT_SPACE, seeds = [SEED_STREAM_INDEX, creator_position.key().as_ref()], bump)]
    pub creator_position_index: Box<Account<'info, StreamIndex>>,
    pub dbc_pool: AccountLoader<'info, dbc::accounts::VirtualPool>,
    pub dbc_config: AccountLoader<'info, dbc::accounts::PoolConfig>,
    /// CHECK: read as a mint of either token program inside the eligibility routine
    pub base_mint: UncheckedAccount<'info>,
    /// The DAMM v2 pool the migration derived to (checked against the config in the handler).
    pub damm_pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    #[account(mut, constraint = creator_position.load()?.pool == damm_pool.key() @ VaultError::AccountMismatch)]
    pub creator_position: AccountLoader<'info, cp_amm::accounts::Position>,
    pub creator_nft_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: DAMM v2 program, by address
    #[account(address = cp_amm::ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 event authority PDA, checked by the callee
    pub cp_amm_event_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_dbc_rights_migrated(ctx: Context<DepositDbcRightsMigrated>) -> Result<()> {
    open_vault_by_depositor(&ctx.accounts.vault, &ctx.accounts.depositor.key())?;
    require_keys_neq!(ctx.accounts.dbc_pool.key(), ctx.accounts.vault.dbc_pool, VaultError::Duplicate);
    require_keys_neq!(ctx.accounts.creator_position.key(), ctx.accounts.vault.own_position, VaultError::Duplicate);
    let pool = ctx.accounts.dbc_pool.load()?;
    let config = ctx.accounts.dbc_config.load()?;
    let elig = check_dbc_rights(&pool.pool_state, &ctx.accounts.dbc_config.key(), &config, &ctx.accounts.base_mint.to_account_info(), &ctx.accounts.vault.key())?;
    require!(elig.migration_progress == DBC_PROGRESS_CREATED_POOL, VaultError::WrongStatus);
    require_keys_eq!(ctx.accounts.damm_pool.key(), elig.derived_damm_pool, VaultError::AccountMismatch);
    let damm_pool = ctx.accounts.damm_pool.load()?;
    require_keys_eq!(damm_pool.token_a_mint, pool.pool_state.base_mint, VaultError::AccountMismatch);
    require_keys_eq!(damm_pool.token_b_mint, WSOL_MINT, VaultError::Ineligible);
    require!(damm_pool.collect_fee_mode == DAMM_COLLECT_ONLY_B || damm_pool.collect_fee_mode == DAMM_COLLECT_COMPOUNDING, VaultError::Ineligible);
    let pos = ctx.accounts.creator_position.load()?;
    check_creator_position(&damm_pool, &pos, &ctx.accounts.creator_nft_account, &ctx.accounts.vault.key(), config.creator_permanent_locked_liquidity_percentage, config.partner_permanent_locked_liquidity_percentage)?;
    let nft_mint = pos.nft_mint;
    drop(pos);
    drop(damm_pool);
    drop(pool);
    drop(config);
    clear_delegate_permission(
        &ctx.accounts.vault,
        &ctx.accounts.creator_position.to_account_info(),
        &ctx.accounts.creator_nft_account.to_account_info(),
        &ctx.accounts.cp_amm_program.to_account_info(),
        &ctx.accounts.cp_amm_event_authority.to_account_info(),
    )?;
    let vault = &mut ctx.accounts.vault;
    let s = &mut ctx.accounts.stream;
    s.vault = vault.key();
    s.index = vault.stream_count;
    s.kind = StreamKind::DbcCreatorRights;
    s.is_own = false;
    s.pool = ctx.accounts.dbc_pool.key();
    s.config = ctx.accounts.dbc_config.key();
    s.derived_damm_pool = elig.derived_damm_pool;
    s.position = ctx.accounts.creator_position.key();
    s.nft_mint = nft_mint;
    s.nft_account = ctx.accounts.creator_nft_account.key();
    s.one_time_claims = elig.one_time_claims;
    s.deposit_ts = Clock::get()?.unix_timestamp;
    ctx.accounts.stream_index.vault = vault.key();
    ctx.accounts.stream_index.stream = s.key();
    ctx.accounts.creator_position_index.vault = vault.key();
    ctx.accounts.creator_position_index.stream = s.key();
    add_active_stream(vault)?;
    emit!(StreamDeposited { vault: vault.key(), stream: s.key(), kind: 0, pool: s.pool, position: s.position });
    Ok(())
}

#[event]
pub struct StreamDeposited {
    pub vault: Pubkey,
    pub stream: Pubkey,
    pub kind: u8,
    pub pool: Pubkey,
    pub position: Pubkey,
}
