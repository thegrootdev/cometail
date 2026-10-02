//! route and settle: income becomes DLMM limit-order bids inside the vault's policy; fills
//! come back and are burned. The DLMM order account is the authority on what each order holds.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::VaultError;
use crate::lb_clmm;
use crate::math;
use crate::state::*;

fn vault_signer(vault: &Vault) -> [Vec<u8>; 3] { [SEED_VAULT.to_vec(), vault.st_mint.to_bytes().to_vec(), vec![vault.bump]] }

/// Minimal view of a DLMM `LimitOrder` account: header (8 + 112 bytes) then 32-byte bins
/// (`LimitOrderBinData`: amount u64, age u32, bin_id i32 at 16, is_ask at 20).
pub struct LimitOrderView { pub lb_pair: Pubkey, pub owner: Pubkey, pub bins: Vec<OrderBin> }
#[derive(Clone, Copy)]
pub struct OrderBin { pub id: i32, pub amount: u64, pub is_ask: bool, pub age: u32 }

/// The limit-order fields of one DLMM `Bin` (`Bin` is 144 bytes; `BinArray` holds 70 of them
/// after an 8 + 48 byte header: index i64, version, padding, lb_pair).
pub struct BinView { pub open_order_amount: u64, pub total_processing_order_amount: u64, pub processed_order_remaining_amount: u64, pub order_age: u32 }
pub const BIN_ARRAY_DISCRIMINATOR: [u8; 8] = [92, 142, 92, 220, 5, 148, 70, 181];
pub const BINS_PER_ARRAY: i32 = 70;
pub const BIN_SIZE: usize = 144;
pub const BIN_ARRAY_HEADER: usize = 8 + 8 + 1 + 7 + 32;

/// Read a bin's limit-order state from the bin array that holds it, among the accounts
/// handed to the cancel CPI; the array must be a DLMM `BinArray` of this pair.
pub fn read_bin(arrays: &[AccountInfo], lb_pair: &Pubkey, bin_id: i32) -> Result<BinView> {
    let index = bin_id.div_euclid(BINS_PER_ARRAY) as i64;
    for info in arrays {
        if *info.owner != lb_clmm::ID { continue; }
        let data = info.try_borrow_data()?;
        if data.len() < BIN_ARRAY_HEADER + BINS_PER_ARRAY as usize * BIN_SIZE || data[..8] != BIN_ARRAY_DISCRIMINATOR { continue; }
        if i64::from_le_bytes(data[8..16].try_into().unwrap()) != index { continue; }
        if Pubkey::new_from_array(data[24..56].try_into().unwrap()) != *lb_pair { continue; }
        let o = BIN_ARRAY_HEADER + bin_id.rem_euclid(BINS_PER_ARRAY) as usize * BIN_SIZE;
        let u64_at = |p: usize| u64::from_le_bytes(data[o + p..o + p + 8].try_into().unwrap());
        return Ok(BinView {
            open_order_amount: u64_at(112),
            total_processing_order_amount: u64_at(120),
            processed_order_remaining_amount: u64_at(128),
            order_age: u32::from_le_bytes(data[o + 136..o + 140].try_into().unwrap()),
        });
    }
    err!(VaultError::AccountMismatch)
}

/// The unfilled principal of one order bin, as DLMM's own reader computes it
/// (`dlmm/commons/src/extensions/limit_order.rs:123-137, 211-236`): untouched while the
/// bin's order age is the order's own; a partially processed generation keeps
/// `ceil(amount * processed_remaining / total_processing)`; anything older is filled.
pub fn unfilled_amount(order_bin: &OrderBin, bin: &BinView) -> Result<u64> {
    if order_bin.age == bin.order_age { return Ok(order_bin.amount); }
    if order_bin.age + 1 == bin.order_age {
        if bin.open_order_amount == 0 && bin.processed_order_remaining_amount == 0 { return Ok(0); }
        if bin.total_processing_order_amount == 0 { return Ok(0); }
        let unfilled = (order_bin.amount as u128)
            .checked_mul(bin.processed_order_remaining_amount as u128).ok_or(VaultError::Overflow)?
            .div_ceil(bin.total_processing_order_amount as u128);
        return u64::try_from(unfilled).map_err(|_| VaultError::Overflow.into());
    }
    require!(order_bin.age + 2 <= bin.order_age, VaultError::ForeignAccount);
    Ok(0)
}
pub const LIMIT_ORDER_DISCRIMINATOR: [u8; 8] = [137, 183, 212, 91, 115, 29, 141, 227];
pub fn read_limit_order(info: &AccountInfo) -> Result<LimitOrderView> {
    require_keys_eq!(*info.owner, lb_clmm::ID, VaultError::ForeignAccount);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 120 && data[..8] == LIMIT_ORDER_DISCRIMINATOR, VaultError::ForeignAccount);
    let lb_pair = Pubkey::new_from_array(data[8..40].try_into().unwrap());
    let owner = Pubkey::new_from_array(data[40..72].try_into().unwrap());
    let bin_count = u16::from_le_bytes([data[72], data[73]]) as usize;
    require!(data.len() >= 120 + 32 * bin_count, VaultError::ForeignAccount);
    let mut bins = Vec::with_capacity(bin_count);
    for i in 0..bin_count {
        let o = 120 + 32 * i;
        let amount = u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
        let age = u32::from_le_bytes(data[o + 8..o + 12].try_into().unwrap());
        let id = i32::from_le_bytes(data[o + 16..o + 20].try_into().unwrap());
        let is_ask = data[o + 20] != 0;
        bins.push(OrderBin { id, amount, is_ask, age });
    }
    Ok(LimitOrderView { lb_pair, owner, bins })
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BinOrder { pub id: i32, pub amount: u64 }

// ---------------------------------------------------------------------------------------
// route: keeper places a ladder of bids with vault income, inside the policy
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct Route<'info> {
    #[account(seeds = [SEED_PROTOCOL], bump = protocol.bump, has_one = keeper @ VaultError::NotKeeper)]
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, constraint = lb_pair.key() == vault.dlmm_pair @ VaultError::AccountMismatch)]
    pub lb_pair: AccountLoader<'info, lb_clmm::accounts::LbPair>,
    /// CHECK: the pair's reserve for the token being deposited (WSOL), checked against the pair
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// Fresh keypair: the DLMM order account.
    #[account(mut)]
    pub limit_order: Signer<'info>,
    #[account(init, payer = keeper, space = 8 + OrderRecord::INIT_SPACE, seeds = [SEED_ORDER, vault.key().as_ref(), limit_order.key().as_ref()], bump)]
    pub order_record: Box<Account<'info, OrderRecord>>,
    #[account(mut, constraint = income_wsol.key() == vault.income_wsol @ VaultError::AccountMismatch)]
    pub income_wsol: Box<Account<'info, TokenAccount>>,
    /// CHECK: DLMM program, by address
    #[account(address = lb_clmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,
    /// CHECK: DLMM event authority PDA, checked by the callee
    pub dlmm_event_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining accounts: the bin arrays the order touches (writable)
}

pub fn route<'info>(ctx: Context<'info, Route<'info>>, bins: Vec<BinOrder>) -> Result<()> {
    let p = &ctx.accounts.protocol;
    require!(!p.paused_routing, VaultError::Paused);
    let v = &ctx.accounts.vault;
    require!(v.status == VaultStatus::Live, VaultError::WrongStatus);
    require!(!bins.is_empty() && bins.len() <= v.policy.max_bins_per_order as usize, VaultError::PolicyViolation);
    let (active_id, bin_step, reserve_x, reserve_y) = {
        let pair = ctx.accounts.lb_pair.load()?;
        (pair.active_id, pair.bin_step, pair.reserve_x, pair.reserve_y)
    };
    let st_is_x = v.st_is_x;
    // buying ST: bids below the active bin when ST is X; asks above it when ST is Y (we deposit WSOL = X)
    let is_ask_side = !st_is_x;
    require_keys_eq!(ctx.accounts.reserve.key(), if st_is_x { reserve_y } else { reserve_x }, VaultError::AccountMismatch);
    let mut gross: u64 = 0;
    let mut last: Option<i32> = None;
    for b in &bins {
        require!(b.amount > 0, VaultError::PolicyViolation);
        if let Some(prev) = last { require!(b.id > prev, VaultError::PolicyViolation); }
        last = Some(b.id);
        if st_is_x { require!(b.id < active_id && b.id <= v.bin_bound, VaultError::PolicyViolation); }
        else { require!(b.id > active_id && b.id >= v.bin_bound, VaultError::PolicyViolation); }
        require!(math::bin_within_cap(bin_step, b.id, v.policy.max_price_q64, st_is_x), VaultError::PolicyViolation);
        gross = gross.checked_add(b.amount).ok_or(VaultError::Overflow)?;
    }
    // period budget: roll, then check before placing
    let now = Clock::get()?.unix_timestamp as u64;
    let period_index = now / v.policy.period_seconds;
    let spent = if period_index != v.routing.period_index { 0 } else { v.routing.spent_this_period };
    require!(spent.checked_add(gross).ok_or(VaultError::Overflow)? <= v.policy.max_spend_per_period, VaultError::PolicyViolation);
    require!(v.routing.outstanding_orders < v.policy.max_outstanding_orders, VaultError::PolicyViolation);
    require!(ctx.accounts.income_wsol.amount >= gross, VaultError::PolicyViolation);

    let seeds = vault_signer(v);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    let signer_seeds: &[&[&[u8]]] = &[signer];
    let params = lb_clmm::types::PlaceLimitOrderParams {
        is_ask_side,
        padding: [0; 16],
        relative_bin: None,
        bins: bins.iter().map(|b| lb_clmm::types::BinLimitOrderAmount { id: b.id, amount: b.amount }).collect(),
    };
    let cpi = CpiContext::new_with_signer(ctx.accounts.dlmm_program.key(), lb_clmm::cpi::accounts::PlaceLimitOrder {
        lb_pair: ctx.accounts.lb_pair.to_account_info(),
        bin_array_bitmap_extension: None,
        reserve: ctx.accounts.reserve.to_account_info(),
        token_mint: ctx.accounts.wsol_mint.to_account_info(),
        limit_order: ctx.accounts.limit_order.to_account_info(),
        payer: ctx.accounts.keeper.to_account_info(),
        owner: v.to_account_info(),
        user_token: ctx.accounts.income_wsol.to_account_info(),
        sender: v.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        event_authority: ctx.accounts.dlmm_event_authority.to_account_info(),
        program: ctx.accounts.dlmm_program.to_account_info(),
    }, signer_seeds).with_remaining_accounts(ctx.remaining_accounts.to_vec());
    lb_clmm::cpi::place_limit_order(cpi, params, lb_clmm::types::RemainingAccountsInfo { slices: vec![] })?;

    let vault = &mut ctx.accounts.vault;
    vault.routing.period_index = period_index;
    vault.routing.spent_this_period = spent.checked_add(gross).ok_or(VaultError::Overflow)?;
    vault.routing.outstanding_orders = vault.routing.outstanding_orders.checked_add(1).ok_or(VaultError::Overflow)?;
    vault.accounting.routed_gross = vault.accounting.routed_gross.checked_add(gross).ok_or(VaultError::Overflow)?;
    let r = &mut ctx.accounts.order_record;
    r.vault = vault.key();
    r.limit_order = ctx.accounts.limit_order.key();
    r.placed_ts = now as i64;
    r.gross_spent = gross;
    r.bin_count = bins.len() as u8;
    r.bump = ctx.bumps.order_record;
    emit!(Routed { vault: vault.key(), limit_order: r.limit_order, gross, bins: bins.len() as u8 });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// settle: cancel bins of a vault order, burn every ST the vault holds, close when empty
// ---------------------------------------------------------------------------------------
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [SEED_PROTOCOL], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(mut, seeds = [SEED_VAULT, vault.st_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// Receives the rent of the order and record accounts when the order closes.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, constraint = lb_pair.key() == vault.dlmm_pair @ VaultError::AccountMismatch)]
    pub lb_pair: AccountLoader<'info, lb_clmm::accounts::LbPair>,
    /// CHECK: checked against the pair
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: checked against the pair
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: read and checked in the handler (the DLMM order account)
    #[account(mut)]
    pub limit_order: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_ORDER, vault.key().as_ref(), limit_order.key().as_ref()], bump = order_record.bump)]
    pub order_record: Box<Account<'info, OrderRecord>>,
    #[account(mut, constraint = income_wsol.key() == vault.income_wsol @ VaultError::AccountMismatch)]
    pub income_wsol: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = st_ata.key() == vault.st_ata @ VaultError::AccountMismatch)]
    pub st_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = vault.st_mint)]
    pub st_mint: Box<Account<'info, Mint>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// CHECK: SPL memo program, by address (DLMM requires it on cancel)
    #[account(address = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"))]
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: DLMM program, by address
    #[account(address = lb_clmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,
    /// CHECK: DLMM event authority PDA, checked by the callee
    pub dlmm_event_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    // remaining accounts: the bin arrays the cancelled bins live in (writable)
}

pub fn settle<'info>(ctx: Context<'info, Settle<'info>>, bins: Vec<i32>) -> Result<()> {
    let v = &ctx.accounts.vault;
    require!(v.status == VaultStatus::Live, VaultError::WrongStatus);
    require!(!bins.is_empty(), VaultError::PolicyViolation);
    let order = read_limit_order(&ctx.accounts.limit_order.to_account_info())?;
    require_keys_eq!(order.owner, v.key(), VaultError::AccountMismatch);
    require_keys_eq!(order.lb_pair, v.dlmm_pair, VaultError::AccountMismatch);
    let (active_id, reserve_x, reserve_y) = { let pair = ctx.accounts.lb_pair.load()?; (pair.active_id, pair.reserve_x, pair.reserve_y) };
    require_keys_eq!(ctx.accounts.reserve_x.key(), reserve_x, VaultError::AccountMismatch);
    require_keys_eq!(ctx.accounts.reserve_y.key(), reserve_y, VaultError::AccountMismatch);
    // every requested bin must be in the order; "fully filled" means the market crossed it entirely:
    // a bid bin above the active bin (price fell through it) or an ask bin below it. The
    // unfilled principal of each bin comes from the bin's own fill state, read before the cancel.
    let mut all_filled = true;
    let mut principal: u64 = 0;
    for b in &bins {
        let found = order.bins.iter().find(|ob| ob.id == *b).ok_or(VaultError::AccountMismatch)?;
        let crossed = if found.is_ask { *b < active_id } else { *b > active_id };
        if !crossed { all_filled = false; }
        let bin = read_bin(ctx.remaining_accounts, &v.dlmm_pair, *b)?;
        principal = principal.checked_add(unfilled_amount(found, &bin)?).ok_or(VaultError::Overflow)?;
    }
    if !all_filled { require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.protocol.keeper, VaultError::NotKeeper); }

    let st_is_x = v.st_is_x;
    let (owner_x, owner_y) = if st_is_x { (ctx.accounts.st_ata.to_account_info(), ctx.accounts.income_wsol.to_account_info()) } else { (ctx.accounts.income_wsol.to_account_info(), ctx.accounts.st_ata.to_account_info()) };
    let (mint_x, mint_y) = if st_is_x { (ctx.accounts.st_mint.to_account_info(), ctx.accounts.wsol_mint.to_account_info()) } else { (ctx.accounts.wsol_mint.to_account_info(), ctx.accounts.st_mint.to_account_info()) };
    let wsol_before = ctx.accounts.income_wsol.amount;
    let seeds = vault_signer(v);
    let signer: &[&[u8]] = &[&seeds[0], &seeds[1], &seeds[2]];
    let signer_seeds: &[&[&[u8]]] = &[signer];
    let cpi = CpiContext::new_with_signer(ctx.accounts.dlmm_program.key(), lb_clmm::cpi::accounts::CancelLimitOrder {
        lb_pair: ctx.accounts.lb_pair.to_account_info(),
        bin_array_bitmap_extension: None,
        reserve_x: ctx.accounts.reserve_x.to_account_info(),
        reserve_y: ctx.accounts.reserve_y.to_account_info(),
        token_x_mint: mint_x,
        token_y_mint: mint_y,
        limit_order: ctx.accounts.limit_order.to_account_info(),
        owner_token_x: owner_x,
        owner_token_y: owner_y,
        owner: v.to_account_info(),
        token_x_program: ctx.accounts.token_program.to_account_info(),
        token_y_program: ctx.accounts.token_program.to_account_info(),
        memo_program: ctx.accounts.memo_program.to_account_info(),
        event_authority: ctx.accounts.dlmm_event_authority.to_account_info(),
        program: ctx.accounts.dlmm_program.to_account_info(),
    }, signer_seeds).with_remaining_accounts(ctx.remaining_accounts.to_vec());
    lb_clmm::cpi::cancel_limit_order(cpi, bins.clone(), lb_clmm::types::RemainingAccountsInfo { slices: vec![] })?;

    // burn every stream token the vault holds, whatever its origin
    ctx.accounts.st_ata.reload()?;
    let burned = ctx.accounts.st_ata.amount;
    if burned > 0 {
        token::burn(CpiContext::new_with_signer(ctx.accounts.token_program.key(), token::Burn { mint: ctx.accounts.st_mint.to_account_info(), from: ctx.accounts.st_ata.to_account_info(), authority: v.to_account_info() }, &[signer]), burned)?;
    }
    // close the DLMM order once nothing is left in any bin (DLMM keeps cancelled bins in the
    // account with a zero amount); the record follows it
    let remaining = read_limit_order(&ctx.accounts.limit_order.to_account_info()).map(|o| o.bins.iter().filter(|ob| ob.amount > 0).count()).unwrap_or(0);
    let mut closed = false;
    if remaining == 0 {
        lb_clmm::cpi::close_limit_order_if_empty(CpiContext::new_with_signer(ctx.accounts.dlmm_program.key(), lb_clmm::cpi::accounts::CloseLimitOrderIfEmpty {
            limit_order: ctx.accounts.limit_order.to_account_info(), owner: v.to_account_info(), rent_receiver: ctx.accounts.signer.to_account_info(),
            event_authority: ctx.accounts.dlmm_event_authority.to_account_info(), program: ctx.accounts.dlmm_program.to_account_info(),
        }, &[signer]))?;
        closed = true;
    }
    ctx.accounts.income_wsol.reload()?;
    let wsol_back = ctx.accounts.income_wsol.amount.checked_sub(wsol_before).ok_or(VaultError::Overflow)?;
    // what came back beyond the unfilled principal is the WSOL fee share (ST = X); with ST = Y
    // the fee share arrives in ST and is burned above, so the WSOL back is principal only
    let refunded = wsol_back.min(principal);
    let fees = wsol_back - refunded;
    let vault = &mut ctx.accounts.vault;
    vault.accounting.refunded_principal = vault.accounting.refunded_principal.checked_add(refunded).ok_or(VaultError::Overflow)?;
    vault.accounting.order_fees_wsol = vault.accounting.order_fees_wsol.checked_add(fees).ok_or(VaultError::Overflow)?;
    vault.accounting.burned_st = vault.accounting.burned_st.checked_add(burned).ok_or(VaultError::Overflow)?;
    if closed {
        vault.routing.outstanding_orders = vault.routing.outstanding_orders.saturating_sub(1);
        // the record follows the order: its rent goes to whoever settled
        anchor_lang::AccountsClose::close(&*ctx.accounts.order_record, ctx.accounts.signer.to_account_info())?;
    }
    emit!(Settled { vault: vault.key(), limit_order: ctx.accounts.limit_order.key(), refunded, fees, burned, closed });
    Ok(())
}

#[event] pub struct Routed { pub vault: Pubkey, pub limit_order: Pubkey, pub gross: u64, pub bins: u8 }
#[event] pub struct Settled { pub vault: Pubkey, pub limit_order: Pubkey, pub refunded: u64, pub fees: u64, pub burned: u64, pub closed: bool }
