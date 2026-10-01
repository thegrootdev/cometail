//! Test-only forwarder. Re-invokes an arbitrary instruction with a `["vault", seed]` PDA
//! added as signer, so the harness can drive DBC, DAMM v2 and DLMM with a program-derived
//! signer in regression tests. It is built by the test suite and never deployed.
//!
//! Instruction data: [bump: u8][seed_len: u8][seed: seed_len bytes][inner_ix_data...]
//! Accounts: [0] target program, [1..] accounts forwarded verbatim. Any account whose key
//! equals the vault PDA is passed to the target as a signer.
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let bump = data[0];
    let seed_len = data[1] as usize;
    if data.len() < 2 + seed_len {
        return Err(ProgramError::InvalidInstructionData);
    }
    let seed = &data[2..2 + seed_len];
    let inner = &data[2 + seed_len..];
    let vault = Pubkey::create_program_address(&[b"vault", seed, &[bump]], program_id)?;

    let target = accounts.get(0).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let metas: Vec<AccountMeta> = accounts[1..]
        .iter()
        .map(|a| {
            let is_signer = a.is_signer || a.key == &vault;
            if a.is_writable {
                AccountMeta::new(*a.key, is_signer)
            } else {
                AccountMeta::new_readonly(*a.key, is_signer)
            }
        })
        .collect();
    let ix = Instruction {
        program_id: *target.key,
        accounts: metas,
        data: inner.to_vec(),
    };
    invoke_signed(&ix, accounts, &[&[b"vault", seed, &[bump]]])
}
