// Instruction builders for the COMETAIL burn program. Pure: no RPC, no signing. Every builder takes
// the accounts it needs from the pinned state the caller read (BurnState) or from Meteora's own state.
import { AnchorProvider, Idl, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID } from "./ids";

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const BURN_IDL = require("../idl/cometail_burn.json") as Idl;
export const BURN_PROGRAM_ID = new PublicKey((BURN_IDL as any).address);
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
const DAMM_POOL_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], DAMM_V2_PROGRAM_ID)[0];
const DBC_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DBC_PROGRAM_ID)[0];
const DAMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DAMM_V2_PROGRAM_ID)[0];

const pda = (seed: string, programId = BURN_PROGRAM_ID) => PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
/** The program's accounts, all PDAs of the program id. `claimer` is the fee claimer the new launch configs name. */
export function burnAccounts(programId = BURN_PROGRAM_ID) {
  return {
    burnState: pda("burn", programId), claimer: pda("claimer", programId), reserve: pda("reserve", programId), inbox: pda("inbox", programId),
    placeholder: pda("placeholder", programId), bought: pda("bought", programId),
    programData: PublicKey.findProgramAddressSync([programId.toBuffer()], UPGRADEABLE_LOADER)[0],
  };
}

const NO_WALLET = { publicKey: Keypair.generate().publicKey, signTransaction: async () => { throw new Error("read-only wallet"); }, signAllTransactions: async () => { throw new Error("read-only wallet"); } };
export function burnProgram(connection?: Connection): Program {
  return new Program(BURN_IDL, new AnchorProvider(connection ?? new Connection("http://127.0.0.1:8899"), NO_WALLET as never, {}));
}

/** The pinned state, as `burnState` decodes it. */
export type BurnState = {
  setupBy: PublicKey; cometailMint: PublicKey; pool: PublicKey; treasury: PublicKey; reserve: PublicKey; inbox: PublicKey; placeholder: PublicKey; bought: PublicKey;
  feeNumerator: { toString(): string }; splitTotal: { toString(): string }; splitToReserve: { toString(): string }; splitToTreasury: { toString(): string };
  spentTotal: { toString(): string }; burnedTotal: { toString(): string }; buybacks: { toString(): string }; lastBuyTs: { toNumber(): number };
};

export class BurnClient {
  readonly program: Program;
  readonly a: ReturnType<typeof burnAccounts>;
  constructor(connection?: Connection, programId = BURN_PROGRAM_ID) {
    this.program = burnProgram(connection);
    this.a = burnAccounts(programId);
  }
  decodeState(data: Buffer): BurnState { return this.program.coder.accounts.decode("burnState", data) as BurnState; }

  /** Signed by the program's upgrade authority, which also pays the rent. */
  setup(a: { authority: PublicKey; cometailMint: PublicKey; pool: PublicKey; treasury: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.setup().accountsPartial({
      burnState: this.a.burnState, authority: a.authority, program: BURN_PROGRAM_ID, programData: this.a.programData, claimer: this.a.claimer,
      cometailMint: a.cometailMint, wsolMint: NATIVE_MINT, pool: a.pool, treasury: a.treasury,
      reserve: this.a.reserve, inbox: this.a.inbox, placeholder: this.a.placeholder, bought: this.a.bought,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
  }

  /** Permissionless. `pool` vaults come from the pinned pool's own state. */
  buyback(a: { state: BurnState; tokenAVault: PublicKey; tokenBVault: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.buyback().accountsPartial({
      burnState: this.a.burnState, reserve: a.state.reserve, bought: a.state.bought, cometailMint: a.state.cometailMint, wsolMint: NATIVE_MINT, pool: a.state.pool,
      poolAuthority: DAMM_POOL_AUTHORITY, tokenAVault: a.tokenAVault, tokenBVault: a.tokenBVault, tokenProgram: TOKEN_PROGRAM_ID,
      cpAmmProgram: DAMM_V2_PROGRAM_ID, cpAmmEventAuthority: DAMM_EVENT_AUTHORITY,
    }).instruction();
  }

  private common(state: BurnState) {
    return { burnState: this.a.burnState, claimer: this.a.claimer, inbox: state.inbox, placeholder: state.placeholder, reserve: state.reserve, treasury: state.treasury, wsolMint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ID };
  }
  /** Owner claims: the signer's own WSOL account receives the other half. */
  private ownerCommon(state: BurnState, owner: PublicKey, ownerWsol: PublicKey) {
    return { burnState: this.a.burnState, inbox: state.inbox, placeholder: state.placeholder, reserve: state.reserve, owner, ownerWsol, wsolMint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ID };
  }
  private curve(a: CurveArgs) {
    return { config: a.config, pool: a.pool, dbcPoolAuthority: DBC_POOL_AUTHORITY, baseVault: a.baseVault, quoteVault: a.quoteVault, baseMint: a.baseMint, baseTokenProgram: a.baseTokenProgram ?? TOKEN_PROGRAM_ID, dbcProgram: DBC_PROGRAM_ID, dbcEventAuthority: DBC_EVENT_AUTHORITY };
  }
  private creation(a: { config: PublicKey; pool: PublicKey }) { return { config: a.config, pool: a.pool, dbcProgram: DBC_PROGRAM_ID, dbcEventAuthority: DBC_EVENT_AUTHORITY }; }
  private surplus(a: { config: PublicKey; pool: PublicKey; quoteVault: PublicKey }) {
    return { config: a.config, pool: a.pool, dbcPoolAuthority: DBC_POOL_AUTHORITY, quoteVault: a.quoteVault, dbcProgram: DBC_PROGRAM_ID, dbcEventAuthority: DBC_EVENT_AUTHORITY };
  }
  private position(a: PositionArgs) {
    return { pool: a.pool, position: a.position, positionNftAccount: a.positionNftAccount, poolAuthority: DAMM_POOL_AUTHORITY, tokenAVault: a.tokenAVault, tokenBVault: a.tokenBVault, tokenAMint: a.tokenAMint, tokenAProgram: a.tokenAProgram ?? TOKEN_PROGRAM_ID, cpAmmProgram: DAMM_V2_PROGRAM_ID, cpAmmEventAuthority: DAMM_EVENT_AUTHORITY };
  }

  /** Program claims: fees owed to the claimer PDA (configs naming it); the whole inbox splits to reserve and treasury. */
  claimCurveFees(a: { state: BurnState } & CurveArgs) { return this.program.methods.claimCurveFees().accountsPartial({ common: this.common(a.state), meteora: this.curve(a) } as any).instruction(); }
  claimCreationFee(a: { state: BurnState; config: PublicKey; pool: PublicKey }) { return this.program.methods.claimCreationFee().accountsPartial({ common: this.common(a.state), meteora: this.creation(a) } as any).instruction(); }
  claimSurplus(a: { state: BurnState; config: PublicKey; pool: PublicKey; quoteVault: PublicKey }) { return this.program.methods.claimSurplus().accountsPartial({ common: this.common(a.state), meteora: this.surplus(a) } as any).instruction(); }
  claimPositionFees(a: { state: BurnState } & PositionArgs) { return this.program.methods.claimPositionFees().accountsPartial({ common: this.common(a.state), meteora: this.position(a) } as any).instruction(); }
  sweepInbox(a: { state: BurnState }) { return this.program.methods.sweepInbox().accountsPartial({ common: this.common(a.state) } as any).instruction(); }

  /** Owner claims (the older configs' fee claimer, or a position's holder, signs): exactly half of what the claim pays to the reserve, half to `ownerWsol`. */
  ownerClaimCurveFees(a: { state: BurnState; owner: PublicKey; ownerWsol: PublicKey } & CurveArgs) { return this.program.methods.ownerClaimCurveFees().accountsPartial({ common: this.ownerCommon(a.state, a.owner, a.ownerWsol), meteora: this.curve(a) } as any).instruction(); }
  ownerClaimCreationFee(a: { state: BurnState; owner: PublicKey; ownerWsol: PublicKey; config: PublicKey; pool: PublicKey }) { return this.program.methods.ownerClaimCreationFee().accountsPartial({ common: this.ownerCommon(a.state, a.owner, a.ownerWsol), meteora: this.creation(a) } as any).instruction(); }
  ownerClaimSurplus(a: { state: BurnState; owner: PublicKey; ownerWsol: PublicKey; config: PublicKey; pool: PublicKey; quoteVault: PublicKey }) { return this.program.methods.ownerClaimSurplus().accountsPartial({ common: this.ownerCommon(a.state, a.owner, a.ownerWsol), meteora: this.surplus(a) } as any).instruction(); }
  ownerClaimPositionFees(a: { state: BurnState; owner: PublicKey; ownerWsol: PublicKey } & PositionArgs) { return this.program.methods.ownerClaimPositionFees().accountsPartial({ common: this.ownerCommon(a.state, a.owner, a.ownerWsol), meteora: this.position(a) } as any).instruction(); }
}

type CurveArgs = { config: PublicKey; pool: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; baseMint: PublicKey; baseTokenProgram?: PublicKey };
type PositionArgs = { pool: PublicKey; position: PublicKey; positionNftAccount: PublicKey; tokenAVault: PublicKey; tokenBVault: PublicKey; tokenAMint: PublicKey; tokenAProgram?: PublicKey };
