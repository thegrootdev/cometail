use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, spl_token_2022::instruction::AuthorityType, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::cp_amm;
use crate::dynamic_bonding_curve as dbc;
use crate::errors::VaultError;
use crate::instructions::deposit::{add_active_stream, clear_delegate_permission};
use crate::instructions::eligibility::*;
use crate::state::*;

fn vault_seeds(vault: &Vault) -> [Vec<u8>; 3] {
    [SEED_VAULT.to_vec(), vault.st_mint.to_bytes().to_vec(), vec![vault.bump]]
}

// ---------------------------------------------------------------------------------------
// register_stream_position: a PreBondingCurve DBC stream migrated; its creator position
// now sits in the vault-owned PDA account the migration re-authorized, and can be recorded
// (permissionless).
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct RegisterStreamPosition<'info> {
    #[account(seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, has_one = vault @ VaultError::AccountMismatch, constraint = stream.kind == StreamKind::DbcCreatorRights @ VaultError::AccountMismatch, constraint = !stream.is_own @ VaultError::AccountMismatch, constraint = stream.position == Pubkey::default() @ VaultError::Duplicate)]
    pub stream: Box<Account<'info, Stream>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + StreamIndex::INIT_SPACE, seeds = [SEED_STREAM_INDEX, position.key().as_ref()], bump)]
    pub stream_index: Account<'info, StreamIndex>,
    #[account(constraint = dbc_pool.key() == stream.pool @ VaultError::AccountMismatch)]
    pub dbc_pool: AccountLoader<'info, dbc::accounts::VirtualPool>,
    #[account(constraint = dbc_config.key() == stream.config @ VaultError::AccountMismatch)]
    pub dbc_config: AccountLoader<'info, dbc::accounts::PoolConfig>,
    #[account(constraint = damm_pool.key() == stream.derived_damm_pool @ VaultError::AccountMismatch)]
    pub damm_pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    #[account(mut, constraint = position.load()?.pool == damm_pool.key() @ VaultError::AccountMismatch)]
    pub position: AccountLoader<'info, cp_amm::accounts::Position>,
    pub nft_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: DAMM v2 program, by address
    #[account(address = cp_amm::ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 event authority PDA, checked by the callee
    pub cp_amm_event_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn register_stream_position(ctx: Context<RegisterStreamPosition>) -> Result<()> {
    // any vault status: an external migration can land before or after the launch
    let dbc_pool = ctx.accounts.dbc_pool.load()?;
    require!(dbc_pool.pool_state.migration_progress == DBC_PROGRESS_CREATED_POOL, VaultError::WrongStatus);
    require_keys_eq!(dbc_pool.pool_state.creator, ctx.accounts.vault.key(), VaultError::AccountMismatch);
    let config = ctx.accounts.dbc_config.load()?;
    let pool = ctx.accounts.damm_pool.load()?;
    require_keys_eq!(pool.token_a_mint, dbc_pool.pool_state.base_mint, VaultError::AccountMismatch);
    require_keys_eq!(pool.token_b_mint, WSOL_MINT, VaultError::Ineligible);
    require!(pool.collect_fee_mode == DAMM_COLLECT_ONLY_B || pool.collect_fee_mode == DAMM_COLLECT_COMPOUNDING, VaultError::Ineligible);
    let pos = ctx.accounts.position.load()?;
    check_creator_position(&pool, &pos, &ctx.accounts.nft_account, &ctx.accounts.vault.key(), config.creator_permanent_locked_liquidity_percentage, config.partner_permanent_locked_liquidity_percentage)?;
    require_keys_neq!(ctx.accounts.position.key(), ctx.accounts.vault.own_position, VaultError::Duplicate);
    let nft_mint = pos.nft_mint;
    drop(pos); drop(pool); drop(config); drop(dbc_pool);
    clear_delegate_permission(
        &ctx.accounts.vault,
        &ctx.accounts.position.to_account_info(),
        &ctx.accounts.nft_account.to_account_info(),
        &ctx.accounts.cp_amm_program.to_account_info(),
        &ctx.accounts.cp_amm_event_authority.to_account_info(),
    )?;
    let s = &mut ctx.accounts.stream;
    s.position = ctx.accounts.position.key();
    s.nft_mint = nft_mint;
    s.nft_account = ctx.accounts.nft_account.key();
    ctx.accounts.stream_index.vault = ctx.accounts.vault.key();
    ctx.accounts.stream_index.stream = s.key();
    emit!(StreamPositionRegistered { vault: ctx.accounts.vault.key(), stream: s.key(), position: s.position });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// deposit_position_split: carve a permanently locked slice (and chosen fee shares) out of
// the depositor's position into a fresh vault-owned position, in one transaction.
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct DepositPositionSplit<'info> {
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(init, payer = depositor, space = 8 + Stream::INIT_SPACE, seeds = [SEED_STREAM, vault.key().as_ref(), &vault.stream_count.to_le_bytes()], bump)]
    pub stream: Box<Account<'info, Stream>>,
    #[account(init, payer = depositor, space = 8 + StreamIndex::INIT_SPACE, seeds = [SEED_STREAM_INDEX, new_position.key().as_ref()], bump)]
    pub stream_index: Account<'info, StreamIndex>,
    #[account(mut)]
    pub damm_pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    /// The depositor's position (source of the slice).
    #[account(mut, constraint = source_position.load()?.pool == damm_pool.key() @ VaultError::AccountMismatch)]
    pub source_position: AccountLoader<'info, cp_amm::accounts::Position>,
    #[account(constraint = source_nft_account.owner == depositor.key() @ VaultError::AccountMismatch, constraint = source_nft_account.mint == source_position.load()?.nft_mint @ VaultError::AccountMismatch)]
    pub source_nft_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Fresh NFT mint for the vault's slice (keypair signs).
    #[account(mut)]
    pub new_nft_mint: Signer<'info>,
    /// CHECK: created by DAMM v2 (PDA `["position_nft_account", mint]`)
    #[account(mut)]
    pub new_nft_account: UncheckedAccount<'info>,
    /// CHECK: created by DAMM v2 (PDA `["position", mint]`)
    #[account(mut)]
    pub new_position: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 pool authority PDA, checked by the callee
    pub cp_amm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: read as a mint of either token program inside the eligibility routine
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 program, by address
    #[account(address = cp_amm::ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 event authority PDA, checked by the callee
    pub cp_amm_event_authority: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_position_split(ctx: Context<DepositPositionSplit>, permanent_locked_pct: u8, fee_a_pct: u8, fee_b_pct: u8) -> Result<()> {
    require!(ctx.accounts.vault.status == VaultStatus::Open, VaultError::WrongStatus);
    require_keys_eq!(ctx.accounts.vault.depositor, ctx.accounts.depositor.key(), VaultError::NotDepositor);
    require!(permanent_locked_pct >= 1 && permanent_locked_pct <= 100 && fee_a_pct <= 100 && fee_b_pct <= 100, VaultError::InvalidPolicy);
    {
        let pool = ctx.accounts.damm_pool.load()?;
        check_damm_pool(&pool, &ctx.accounts.base_mint.to_account_info())?;
    }
    // 1. empty destination position owned by the vault
    cp_amm::cpi::create_position(CpiContext::new(ctx.accounts.cp_amm_program.key(), cp_amm::cpi::accounts::CreatePosition {
        owner: ctx.accounts.vault.to_account_info(),
        position_nft_mint: ctx.accounts.new_nft_mint.to_account_info(),
        position_nft_account: ctx.accounts.new_nft_account.to_account_info(),
        pool: ctx.accounts.damm_pool.to_account_info(),
        position: ctx.accounts.new_position.to_account_info(),
        pool_authority: ctx.accounts.cp_amm_pool_authority.to_account_info(),
        payer: ctx.accounts.depositor.to_account_info(),
        token_program: ctx.accounts.token_2022_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        event_authority: ctx.accounts.cp_amm_event_authority.to_account_info(),
        program: ctx.accounts.cp_amm_program.to_account_info(),
    }))?;
    // 2. split: only permanently locked liquidity and the chosen fee shares move
    let seeds = vault_seeds(&ctx.accounts.vault);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    cp_amm::cpi::split_position(CpiContext::new_with_signer(ctx.accounts.cp_amm_program.key(), cp_amm::cpi::accounts::SplitPosition {
        pool: ctx.accounts.damm_pool.to_account_info(),
        first_position: ctx.accounts.source_position.to_account_info(),
        first_position_nft_account: ctx.accounts.source_nft_account.to_account_info(),
        second_position: ctx.accounts.new_position.to_account_info(),
        second_position_nft_account: ctx.accounts.new_nft_account.to_account_info(),
        first_owner: ctx.accounts.depositor.to_account_info(),
        second_owner: ctx.accounts.vault.to_account_info(),
        event_authority: ctx.accounts.cp_amm_event_authority.to_account_info(),
        program: ctx.accounts.cp_amm_program.to_account_info(),
    }, &[signer]), cp_amm::types::SplitPositionParameters {
        unlocked_liquidity_percentage: 0,
        permanent_locked_liquidity_percentage: permanent_locked_pct,
        fee_a_percentage: fee_a_pct,
        fee_b_percentage: fee_b_pct,
        reward_0_percentage: 0,
        reward_1_percentage: 0,
        inner_vesting_liquidity_percentage: 0,
        padding: [0; 15],
    })?;
    // 3. verify what the vault now holds, straight from the accounts
    let pos = read_position(&ctx.accounts.new_position.to_account_info())?;
    require_keys_eq!(pos.pool, ctx.accounts.damm_pool.key(), VaultError::AccountMismatch);
    check_position_principal(&pos)?;
    let nft_mint = pos.nft_mint;
    check_nft_account_raw(&ctx.accounts.new_nft_account.to_account_info(), &ctx.accounts.vault.key(), &nft_mint)?;

    let vault = &mut ctx.accounts.vault;
    let s = &mut ctx.accounts.stream;
    s.vault = vault.key();
    s.index = vault.stream_count;
    s.kind = StreamKind::DammV2Position;
    s.is_own = false;
    s.pool = ctx.accounts.damm_pool.key();
    s.config = Pubkey::default();
    s.derived_damm_pool = ctx.accounts.damm_pool.key();
    s.position = ctx.accounts.new_position.key();
    s.nft_mint = nft_mint;
    s.nft_account = ctx.accounts.new_nft_account.key();
    s.one_time_claims = 0;
    s.deposit_ts = Clock::get()?.unix_timestamp;
    ctx.accounts.stream_index.vault = vault.key();
    ctx.accounts.stream_index.stream = s.key();
    add_active_stream(vault)?;
    emit!(crate::instructions::deposit::StreamDeposited { vault: vault.key(), stream: s.key(), kind: 2, pool: s.pool, position: s.position });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// withdraw_stream: Open only. Rights go back through DBC; an NFT in cp-amm's PDA account
// goes back by handing the account's authority to the depositor, any other vault-owned
// account by a token transfer; fees untouched. The Stream and every StreamIndex it owns
// close to the depositor, so the sources can enter a vault again.
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct WithdrawStream<'info> {
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, close = depositor, has_one = vault @ VaultError::AccountMismatch, constraint = !stream.is_own @ VaultError::AccountMismatch)]
    pub stream: Box<Account<'info, Stream>>,
    /// Index of the primary source (DBC pool or position); it must belong to this stream.
    #[account(mut, close = depositor, seeds = [SEED_STREAM_INDEX, stream_index_key.key().as_ref()], bump, constraint = stream_index.stream == stream.key() @ VaultError::AccountMismatch)]
    pub stream_index: Account<'info, StreamIndex>,
    /// CHECK: the key the index was derived from (pool for DBC rights, position otherwise)
    pub stream_index_key: UncheckedAccount<'info>,
    /// Index of the creator position of a DBC-rights stream (bundled or registered), if any.
    #[account(mut, close = depositor, seeds = [SEED_STREAM_INDEX, stream.position.as_ref()], bump, constraint = position_index.stream == stream.key() @ VaultError::AccountMismatch)]
    pub position_index: Option<Account<'info, StreamIndex>>,
    /// CHECK: DBC pool (DBC rights only)
    #[account(mut)]
    pub dbc_pool: Option<UncheckedAccount<'info>>,
    /// CHECK: DBC config (DBC rights only)
    pub dbc_config: Option<UncheckedAccount<'info>>,
    /// CHECK: DBC program, by address
    #[account(address = dbc::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: DBC event authority PDA, checked by the callee
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// Vault-owned NFT account (if the stream holds a position).
    #[account(mut)]
    pub nft_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub nft_mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    /// Depositor-owned destination for the NFT (only when the NFT is not in cp-amm's PDA account).
    #[account(mut, constraint = depositor_nft_account.owner == depositor.key() @ VaultError::AccountMismatch)]
    pub depositor_nft_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn withdraw_stream(ctx: Context<WithdrawStream>) -> Result<()> {
    require!(ctx.accounts.vault.status == VaultStatus::Open, VaultError::WrongStatus);
    require_keys_eq!(ctx.accounts.vault.depositor, ctx.accounts.depositor.key(), VaultError::NotDepositor);
    let s = &ctx.accounts.stream;
    let expected_index_key = if s.kind == StreamKind::DbcCreatorRights { s.pool } else { s.position };
    require_keys_eq!(ctx.accounts.stream_index_key.key(), expected_index_key, VaultError::AccountMismatch);
    let seeds = vault_seeds(&ctx.accounts.vault);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    if s.kind == StreamKind::DbcCreatorRights {
        let pool = ctx.accounts.dbc_pool.as_ref().ok_or(VaultError::AccountMismatch)?;
        let config = ctx.accounts.dbc_config.as_ref().ok_or(VaultError::AccountMismatch)?;
        require_keys_eq!(pool.key(), s.pool, VaultError::AccountMismatch);
        require_keys_eq!(config.key(), s.config, VaultError::AccountMismatch);
        dbc::cpi::transfer_pool_creator(CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), dbc::cpi::accounts::TransferPoolCreator {
            virtual_pool: pool.to_account_info(), config: config.to_account_info(), creator: ctx.accounts.vault.to_account_info(),
            new_creator: ctx.accounts.depositor.to_account_info(), event_authority: ctx.accounts.dbc_event_authority.to_account_info(), program: ctx.accounts.dbc_program.to_account_info(),
        }, &[signer]))?;
    }
    if s.position != Pubkey::default() {
        // a position's index is the primary one for position streams and a second one for
        // DBC-rights streams (bundled at deposit or registered after the migration): it closes here
        match s.kind {
            StreamKind::DammV2Position => require!(ctx.accounts.position_index.is_none(), VaultError::AccountMismatch),
            StreamKind::DbcCreatorRights => require!(ctx.accounts.position_index.is_some(), VaultError::AccountMismatch),
        }
        let from = ctx.accounts.nft_account.as_ref().ok_or(VaultError::AccountMismatch)?;
        let mint = ctx.accounts.nft_mint.as_ref().ok_or(VaultError::AccountMismatch)?;
        require_keys_eq!(from.key(), s.nft_account, VaultError::AccountMismatch);
        require_keys_eq!(mint.key(), s.nft_mint, VaultError::AccountMismatch);
        if from.key() == position_nft_account_pda(&s.nft_mint) {
            // cp-amm's own account for this NFT: the depositor gets the account's authority back
            require!(ctx.accounts.depositor_nft_account.is_none(), VaultError::AccountMismatch);
            token_2022::set_authority(CpiContext::new_with_signer(ctx.accounts.token_2022_program.key(), token_2022::SetAuthority {
                current_authority: ctx.accounts.vault.to_account_info(), account_or_mint: from.to_account_info(),
            }, &[signer]), AuthorityType::AccountOwner, Some(ctx.accounts.depositor.key()))?;
        } else {
            let to = ctx.accounts.depositor_nft_account.as_ref().ok_or(VaultError::AccountMismatch)?;
            require_keys_eq!(to.mint, s.nft_mint, VaultError::AccountMismatch);
            token_2022::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_2022_program.key(), token_2022::TransferChecked {
                from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
            }, &[signer]), 1, 0)?;
        }
    } else {
        require!(ctx.accounts.position_index.is_none(), VaultError::AccountMismatch);
    }
    let vault = &mut ctx.accounts.vault;
    vault.active_streams = vault.active_streams.checked_sub(1).ok_or(VaultError::Overflow)?;
    emit!(StreamWithdrawn { vault: vault.key(), stream: s.key() });
    Ok(())
}

#[event]
pub struct StreamPositionRegistered { pub vault: Pubkey, pub stream: Pubkey, pub position: Pubkey }
#[event]
pub struct StreamWithdrawn { pub vault: Pubkey, pub stream: Pubkey }
