import { expect } from "chai";
import { startSvm, vaultProgramId, DBC_PROGRAM_ID, DLMM_PROGRAM_ID, DAMM_V2_MIGRATION_CONFIG } from "./svm";

describe("harness smoke", () => {
  it("loads the live Meteora binaries, the cloned configs and the vault program", () => {
    const svm = startSvm();
    expect(svm.getAccount(DBC_PROGRAM_ID)!.executable).true;
    expect(svm.getAccount(DLMM_PROGRAM_ID)!.executable).true;
    expect(svm.getAccount(vaultProgramId())!.executable).true;
    expect(svm.getAccount(DAMM_V2_MIGRATION_CONFIG.customizable)!.data.length).eq(328);
  });
});
