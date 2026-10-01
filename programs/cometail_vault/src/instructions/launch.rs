use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::token_interface::TokenAccount as TokenAccountIf;

use crate::constants::*;
use crate::cp_amm;
use crate::dynamic_bonding_curve as dbc;
use crate::errors::VaultError;
use crate::instructions::eligibility::*;
use crate::instructions::protocol::check_stream_config;
use crate::instructions::streams::check_creator_side;
use crate::lb_clmm;
use crate::math;
use crate::state::*;

fn vault_signer(vault: &Vault) -> [Vec<u8>; 3] { [SEED_VAULT.to_vec(), vault.st_mint.to_bytes().to_vec(), vec![vault.bump]] }

pub const METAPLEX_PROGRAM_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/// DLMM bin steps the protocol accepts for stream-token pairs.
pub const APPROVED_BIN_STEPS: [u16; 6] = [10, 20, 25, 50, 80, 100];
pub const DLMM_PAIR_TYPE_CUSTOMIZABLE: u8 = 2;
pub const DLMM_PAIR_TYPE_PERMISSIONLESS_V2: u8 = 3;
pub const DLMM_FUNCTION_LIMIT_ORDER: u8 = 2;
pub const DLMM_COLLECT_ONLY_Y: u8 = 1;
pub const DLMM_STATUS_ENABLED: u8 = 0;

// ---------------------------------------------------------------------------------------
// launch: the vault PDA creates the stream token's DBC pool from a protocol config
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct Launch<'info> {
    #[account(seeds = [SEED_PROTOCOL], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// The recorded stream-token mint; DBC initializes it here.
    #[account(mut, constraint = st_mint.key() == vault.st_mint @ VaultError::WrongMint)]
    pub st_mint: Signer<'info>,
    /// CHECK: one of the protocol's stream configs, checked against the preset in the handler
    pub config: UncheckedAccount<'info>,
    /// CHECK: DBC pool PDA, created by DBC
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: DBC pool authority, by address
    #[account(address = DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: created by DBC
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: created by DBC
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: created by DBC through Metaplex
    #[account(mut)]
    pub mint_metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex token metadata program, by address
    #[account(address = METAPLEX_PROGRAM_ID)]
    pub metadata_program: UncheckedAccount<'info>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// Own-pool stream record.
    #[account(init, payer = depositor, space = 8 + Stream::INIT_SPACE, seeds = [SEED_STREAM, vault.key().as_ref(), &vault.stream_count.to_le_bytes()], bump)]
    pub stream: Box<Account<'info, Stream>>,
    #[account(init, payer = depositor, space = 8 + StreamIndex::INIT_SPACE, seeds = [SEED_STREAM_INDEX, pool.key().as_ref()], bump)]
    pub stream_index: Box<Account<'info, StreamIndex>>,
    /// CHECK: the vault's ST ATA, created here after the mint exists
    #[account(mut, constraint = st_ata.key() == vault.st_ata @ VaultError::AccountMismatch)]
    pub st_ata: UncheckedAccount<'info>,
    /// CHECK: DBC program, by address
    #[account(address = dbc::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: DBC event authority PDA, checked by the callee
    pub dbc_event_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LaunchMetadata { pub name: String, pub symbol: String, pub uri: String }

pub fn launch(ctx: Context<Launch>, preset: u8, metadata: LaunchMetadata) -> Result<()> {
    let v = &ctx.accounts.vault;
    require!(v.status == VaultStatus::Open, VaultError::WrongStatus);
    require_keys_eq!(v.depositor, ctx.accounts.depositor.key(), VaultError::NotDepositor);
    require!(v.stream_count > 0, VaultError::Ineligible); // a vault launches streams, not air
    require!((preset as usize) < 3, VaultError::InvalidPreset);
    require_keys_eq!(ctx.accounts.config.key(), ctx.accounts.protocol.stream_configs[preset as usize], VaultError::AccountMismatch);
    check_stream_config(&ctx.accounts.config.to_account_info(), &ctx.accounts.protocol.admin, preset as usize)?;
    let seeds = vault_signer(v);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    dbc::cpi::initialize_virtual_pool_with_spl_token(
        CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), dbc::cpi::accounts::InitializeVirtualPoolWithSplToken {
            config: ctx.accounts.config.to_account_info(),
            pool_authority: ctx.accounts.dbc_pool_authority.to_account_info(),
            creator: v.to_account_info(),
            base_mint: ctx.accounts.st_mint.to_account_info(),
            quote_mint: ctx.accounts.wsol_mint.to_account_info(),
            pool: ctx.accounts.pool.to_account_info(),
            base_vault: ctx.accounts.base_vault.to_account_info(),
            quote_vault: ctx.accounts.quote_vault.to_account_info(),
            mint_metadata: ctx.accounts.mint_metadata.to_account_info(),
            metadata_program: ctx.accounts.metadata_program.to_account_info(),
            payer: ctx.accounts.depositor.to_account_info(),
            token_quote_program: ctx.accounts.token_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            event_authority: ctx.accounts.dbc_event_authority.to_account_info(),
            program: ctx.accounts.dbc_program.to_account_info(),
        }, &[signer]),
        dbc::types::InitializePoolParameters { name: metadata.name, symbol: metadata.symbol, uri: metadata.uri },
    )?;
    // the mint exists now: the vault's ST ATA
    associated_token::create(CpiContext::new(ctx.accounts.associated_token_program.key(), associated_token::Create {
        payer: ctx.accounts.depositor.to_account_info(),
        associated_token: ctx.accounts.st_ata.to_account_info(),
        authority: v.to_account_info(),
        mint: ctx.accounts.st_mint.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    }))?;
    // verify the pool DBC just created and record it
    let pool_info = ctx.accounts.pool.to_account_info();
    require_keys_eq!(*pool_info.owner, dbc::ID, VaultError::ForeignAccount);
    {
        let data = pool_info.try_borrow_data()?;
        let disc = <dbc::accounts::VirtualPool as anchor_lang::Discriminator>::DISCRIMINATOR;
        require!(data.len() >= 8 && data[..8] == *disc, VaultError::ForeignAccount);
        let p: &dbc::types::PoolState = bytemuck::from_bytes(&data[8..8 + core::mem::size_of::<dbc::types::PoolState>()]);
        require_keys_eq!(p.creator, v.key(), VaultError::AccountMismatch);
        require_keys_eq!(p.base_mint, v.st_mint, VaultError::AccountMismatch);
        require_keys_eq!(p.config, ctx.accounts.config.key(), VaultError::AccountMismatch);
    }
    let derived = derive_damm_pool(&DAMM_V2_MIGRATION_CONFIGS[6], &v.st_mint, &WSOL_MINT);
    let vault = &mut ctx.accounts.vault;
    vault.status = VaultStatus::Launched;
    vault.preset = preset;
    vault.dbc_pool = ctx.accounts.pool.key();
    vault.dbc_config = ctx.accounts.config.key();
    vault.damm_pool = derived;
    let s = &mut ctx.accounts.stream;
    s.vault = vault.key();
    s.index = vault.stream_count;
    s.kind = StreamKind::DbcCreatorRights;
    s.is_own = true;
    s.pool = ctx.accounts.pool.key();
    s.config = ctx.accounts.config.key();
    s.derived_damm_pool = derived;
    s.deposit_ts = Clock::get()?.unix_timestamp;
    ctx.accounts.stream_index.vault = vault.key();
    ctx.accounts.stream_index.stream = s.key();
    vault.stream_count = vault.stream_count.checked_add(1).ok_or(VaultError::Overflow)?;
    emit!(Launched { vault: vault.key(), st_mint: vault.st_mint, dbc_pool: vault.dbc_pool, preset });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// register_pair: write-once binding of the stream token's DLMM pair, with the price bound
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct RegisterPair<'info> {
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub lb_pair: AccountLoader<'info, lb_clmm::accounts::LbPair>,
}

pub fn register_pair(ctx: Context<RegisterPair>) -> Result<()> {
    let v = &ctx.accounts.vault;
    require!(v.status != VaultStatus::Open, VaultError::WrongStatus);
    require_keys_eq!(v.dlmm_pair, Pubkey::default(), VaultError::Duplicate);
    let pair = ctx.accounts.lb_pair.load()?;
    let st_is_x = if pair.token_x_mint == v.st_mint && pair.token_y_mint == WSOL_MINT { true }
        else if pair.token_y_mint == v.st_mint && pair.token_x_mint == WSOL_MINT { false }
        else { return err!(VaultError::AccountMismatch) };
    require!(pair.pair_type == DLMM_PAIR_TYPE_CUSTOMIZABLE || pair.pair_type == DLMM_PAIR_TYPE_PERMISSIONLESS_V2, VaultError::Ineligible);
    require!(pair.status == DLMM_STATUS_ENABLED, VaultError::Ineligible);
    require!(pair.creator_pool_on_off_control == 0, VaultError::Ineligible);
    require!(pair.parameters.function_type == DLMM_FUNCTION_LIMIT_ORDER, VaultError::Ineligible);
    require!(pair.parameters.collect_fee_mode == DLMM_COLLECT_ONLY_Y, VaultError::Ineligible);
    require!(APPROVED_BIN_STEPS.contains(&pair.bin_step), VaultError::Ineligible);
    let now = Clock::get()?.unix_timestamp as u64;
    require!(pair.activation_point <= now, VaultError::Ineligible);
    require_keys_eq!(pair.pre_activation_swap_address, Pubkey::default(), VaultError::Ineligible);
    let bound = math::bin_bound(pair.bin_step, v.policy.max_price_q64, st_is_x).ok_or(VaultError::InvalidPolicy)?;
    let bin_step = pair.bin_step;
    drop(pair);
    let vault = &mut ctx.accounts.vault;
    vault.dlmm_pair = ctx.accounts.lb_pair.key();
    vault.st_is_x = st_is_x;
    vault.bin_bound = bound;
    emit!(PairRegistered { vault: vault.key(), pair: vault.dlmm_pair, st_is_x, bin_step, bin_bound: bound });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// register_own_position: after the stream token's own migration, record the creator
// position the vault owns and go Live
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct RegisterOwnPosition<'info> {
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Stream::INIT_SPACE, seeds = [SEED_STREAM, vault.key().as_ref(), &vault.stream_count.to_le_bytes()], bump)]
    pub stream: Box<Account<'info, Stream>>,
    #[account(init, payer = payer, space = 8 + StreamIndex::INIT_SPACE, seeds = [SEED_STREAM_INDEX, position.key().as_ref()], bump)]
    pub stream_index: Box<Account<'info, StreamIndex>>,
    #[account(constraint = dbc_pool.key() == vault.dbc_pool @ VaultError::AccountMismatch)]
    pub dbc_pool: AccountLoader<'info, dbc::accounts::VirtualPool>,
    #[account(constraint = dbc_config.key() == vault.dbc_config @ VaultError::AccountMismatch)]
    pub dbc_config: AccountLoader<'info, dbc::accounts::PoolConfig>,
    #[account(constraint = damm_pool.key() == vault.damm_pool @ VaultError::AccountMismatch)]
    pub damm_pool: AccountLoader<'info, cp_amm::accounts::Pool>,
    #[account(mut, constraint = position.load()?.pool == damm_pool.key() @ VaultError::AccountMismatch)]
    pub position: AccountLoader<'info, cp_amm::accounts::Position>,
    pub nft_account: Box<InterfaceAccount<'info, TokenAccountIf>>,
    /// CHECK: DAMM v2 program, by address
    #[account(address = cp_amm::ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 event authority PDA, checked by the callee
    pub cp_amm_event_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn register_own_position(ctx: Context<RegisterOwnPosition>) -> Result<()> {
    let v = &ctx.accounts.vault;
    require!(v.status == VaultStatus::Launched, VaultError::WrongStatus);
    let dbc_pool = ctx.accounts.dbc_pool.load()?;
    require!(dbc_pool.pool_state.migration_progress == DBC_PROGRESS_CREATED_POOL, VaultError::WrongStatus);
    require_keys_eq!(dbc_pool.pool_state.creator, v.key(), VaultError::AccountMismatch);
    let config = ctx.accounts.dbc_config.load()?;
    let pool = ctx.accounts.damm_pool.load()?;
    require_keys_eq!(pool.token_a_mint, v.st_mint, VaultError::AccountMismatch);
    require_keys_eq!(pool.token_b_mint, WSOL_MINT, VaultError::Ineligible);
    require!(pool.collect_fee_mode == DAMM_COLLECT_COMPOUNDING, VaultError::Ineligible);
    let pos = ctx.accounts.position.load()?;
    check_position_principal(&pos)?;
    check_creator_side(&pool, &pos, config.creator_permanent_locked_liquidity_percentage)?;
    check_nft_account(&ctx.accounts.nft_account, &v.key(), &pos.nft_mint)?;
    let nft_mint = pos.nft_mint;
    drop(pos); drop(pool); drop(config); drop(dbc_pool);
    let seeds = vault_signer(v);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    cp_amm::cpi::update_delegate_permission(CpiContext::new_with_signer(ctx.accounts.cp_amm_program.key(), cp_amm::cpi::accounts::UpdateDelegatePermission {
        position: ctx.accounts.position.to_account_info(), position_nft_account: ctx.accounts.nft_account.to_account_info(),
        owner: v.to_account_info(), event_authority: ctx.accounts.cp_amm_event_authority.to_account_info(), program: ctx.accounts.cp_amm_program.to_account_info(),
    }, &[signer]), 0)?;
    let vault = &mut ctx.accounts.vault;
    vault.own_position = ctx.accounts.position.key();
    vault.own_position_nft_account = ctx.accounts.nft_account.key();
    vault.status = VaultStatus::Live;
    let s = &mut ctx.accounts.stream;
    s.vault = vault.key();
    s.index = vault.stream_count;
    s.kind = StreamKind::DammV2Position;
    s.is_own = true;
    s.pool = ctx.accounts.damm_pool.key();
    s.derived_damm_pool = ctx.accounts.damm_pool.key();
    s.position = ctx.accounts.position.key();
    s.nft_mint = nft_mint;
    s.nft_account = ctx.accounts.nft_account.key();
    s.deposit_ts = Clock::get()?.unix_timestamp;
    ctx.accounts.stream_index.vault = vault.key();
    ctx.accounts.stream_index.stream = s.key();
    vault.stream_count = vault.stream_count.checked_add(1).ok_or(VaultError::Overflow)?;
    emit!(Live { vault: vault.key(), damm_pool: vault.damm_pool, position: vault.own_position });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// cashout: the stream token's migration fee (and any surplus) to the depositor, once each
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct Cashout<'info> {
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, constraint = dbc_pool.key() == vault.dbc_pool @ VaultError::AccountMismatch)]
    pub dbc_pool: AccountLoader<'info, dbc::accounts::VirtualPool>,
    /// CHECK: the pool's config, checked against the vault
    #[account(constraint = dbc_config.key() == vault.dbc_config @ VaultError::AccountMismatch)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: DBC pool authority, by address
    #[account(address = DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: the pool's quote vault, checked against the pool in the handler
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(mut, constraint = depositor_wsol.key() == vault.depositor_wsol @ VaultError::AccountMismatch)]
    pub depositor_wsol: Box<Account<'info, TokenAccount>>,
    /// CHECK: DBC program, by address
    #[account(address = dbc::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: DBC event authority PDA, checked by the callee
    pub dbc_event_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn cashout(ctx: Context<Cashout>) -> Result<()> {
    let v = &ctx.accounts.vault;
    require!(v.status != VaultStatus::Open, VaultError::WrongStatus);
    let (fee_pending, surplus_pending) = {
        let p = ctx.accounts.dbc_pool.load()?;
        require_keys_eq!(p.pool_state.quote_vault, ctx.accounts.quote_vault.key(), VaultError::AccountMismatch);
        let threshold_reached = p.pool_state.migration_progress != DBC_PROGRESS_PRE_BONDING;
        (threshold_reached && p.pool_state.migration_fee_withdraw_status & DBC_CREATOR_MIGRATION_FEE_MASK == 0,
         threshold_reached && p.pool_state.is_creator_withdraw_surplus == 0)
    };
    require!(fee_pending || surplus_pending, VaultError::WrongStatus);
    let before = ctx.accounts.depositor_wsol.amount;
    let seeds = vault_signer(v);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    if fee_pending {
        dbc::cpi::withdraw_migration_fee(CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), dbc::cpi::accounts::WithdrawMigrationFee {
            pool_authority: ctx.accounts.dbc_pool_authority.to_account_info(), config: ctx.accounts.dbc_config.to_account_info(), virtual_pool: ctx.accounts.dbc_pool.to_account_info(),
            token_quote_account: ctx.accounts.depositor_wsol.to_account_info(), quote_vault: ctx.accounts.quote_vault.to_account_info(), quote_mint: ctx.accounts.wsol_mint.to_account_info(),
            sender: v.to_account_info(), token_quote_program: ctx.accounts.token_program.to_account_info(), event_authority: ctx.accounts.dbc_event_authority.to_account_info(), program: ctx.accounts.dbc_program.to_account_info(),
        }, &[signer]), 1)?;
    }
    if surplus_pending {
        dbc::cpi::creator_withdraw_surplus(CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), dbc::cpi::accounts::CreatorWithdrawSurplus {
            pool_authority: ctx.accounts.dbc_pool_authority.to_account_info(), config: ctx.accounts.dbc_config.to_account_info(), virtual_pool: ctx.accounts.dbc_pool.to_account_info(),
            token_quote_account: ctx.accounts.depositor_wsol.to_account_info(), quote_vault: ctx.accounts.quote_vault.to_account_info(), quote_mint: ctx.accounts.wsol_mint.to_account_info(),
            creator: v.to_account_info(), token_quote_program: ctx.accounts.token_program.to_account_info(), event_authority: ctx.accounts.dbc_event_authority.to_account_info(), program: ctx.accounts.dbc_program.to_account_info(),
        }, &[signer]))?;
    }
    ctx.accounts.depositor_wsol.reload()?;
    let paid = ctx.accounts.depositor_wsol.amount.checked_sub(before).ok_or(VaultError::Overflow)?;
    let vault = &mut ctx.accounts.vault;
    vault.accounting.cashed_out = vault.accounting.cashed_out.checked_add(paid).ok_or(VaultError::Overflow)?;
    emit!(CashedOut { vault: vault.key(), amount: paid });
    Ok(())
}

#[event] pub struct Launched { pub vault: Pubkey, pub st_mint: Pubkey, pub dbc_pool: Pubkey, pub preset: u8 }
#[event] pub struct PairRegistered { pub vault: Pubkey, pub pair: Pubkey, pub st_is_x: bool, pub bin_step: u16, pub bin_bound: i32 }
#[event] pub struct Live { pub vault: Pubkey, pub damm_pool: Pubkey, pub position: Pubkey }
#[event] pub struct CashedOut { pub vault: Pubkey, pub amount: u64 }
