// The outside-coin devnet run's partner-fee checkpoints: an interrupted attempt that recorded
// checkpoint 2 and then repeats the source trading on resume must be judged against its newer
// checkpoint 2, never the stale one; checkpoint 1 stays mandatory and must be recorded equal.
import { expect } from "chai";
import { partnerFeeCheckpoints } from "../devnet/outside-checks";

const roles = { poolA: "A1", poolB: "B1", feeClaimer: "P", leftoverReceiver: "P" };
const cp1 = { name: "partner fee checkpoint 1 after", ...roles, A: "100", B: "50", equal: true };
const cp2 = (A: string) => ({ name: "partner fee checkpoint 2 before", ...roles, A, B: "50" });

describe("outside-coin run: partner-fee checkpoints", () => {
  it("a resumed attempt that repeated the source trading is judged against its newer checkpoint 2", () => {
    const steps = [cp1, { name: "keeper pass 1" }, cp2("101"), { name: "buyer tops WSOL up (resume)" }, cp2("102")];
    expect(partnerFeeCheckpoints(steps).cp2.A).eq("102");
  });
  it("one attempt: its only checkpoint 2", () => {
    expect(partnerFeeCheckpoints([cp1, cp2("101")]).cp2).deep.eq({ ...roles, A: "101", B: "50" });
  });
  it("checkpoint 1 missing or not recorded equal fails", () => {
    expect(() => partnerFeeCheckpoints([cp2("101")])).throw(/checkpoint 1/);
    expect(() => partnerFeeCheckpoints([{ ...cp1, equal: false }, cp2("101")])).throw(/checkpoint 1/);
  });
  it("checkpoint 2 missing fails", () => {
    expect(() => partnerFeeCheckpoints([cp1])).throw(/checkpoint 2/);
  });
});
