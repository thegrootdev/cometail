// The indexer's main thread serves the API, and holds of 5 to 22 s about six times a day had no visible cause (spike
// 228: no visitor request at their times, no swap, no write burst). worker/src/holds.ts logs each hold over a second
// as it ends, with the main thread's own CPU in it (work on the thread vs a wait in a synchronous call), the GC in
// it, and the step each lane had begun.
import { expect } from "chai";
import { holdWatch, mainThreadCpuMs, stage } from "../../worker/src/holds";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spin = (ms: number) => { const end = Date.now() + ms; let x = 0; while (Date.now() < end) x++; return x; };
const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
type Line = { msg: string; f: any };

describe("event loop hold log (spike 228)", () => {
  it("reads the main thread's own CPU", () => {
    const a = mainThreadCpuMs(); spin(300); const b = mainThreadCpuMs();
    expect(a).to.be.a("number"); expect(b! - a!).to.be.within(200, 500);
  });

  it("a hold of work on the thread: its length, CPU near it, and the stage each lane had begun", async () => {
    const lines: Line[] = []; const w = holdWatch({ log: (msg, f) => lines.push({ msg, f }) });
    try {
      await sleep(250);
      stage("loop", "token scan"); stage("api", "GET /api/stats");
      spin(1_400);
      await sleep(300);
      expect(lines.length).to.eq(1);
      const f = lines[0].f;
      expect(lines[0].msg).to.eq("event loop hold");
      expect(f.ms).to.be.within(1_350, 1_800);
      expect(f.mainCpuMs).to.be.within(1_100, 1_800);
      expect(f.stages.loop.label).to.eq("token scan"); expect(f.stages.api.label).to.eq("GET /api/stats");
      expect(f.stages.loop.beganMsBefore).to.be.within(-100, 200); // the hold's start is known to one tick
      expect(f.gcMs).to.be.a("number"); expect(f.gcKinds).to.be.an("object");
    } finally { w.stop(); }
  });

  it("a hold that waits inside a synchronous call shows almost no CPU", async () => {
    const lines: Line[] = []; const w = holdWatch({ log: (msg, f) => lines.push({ msg, f }) });
    try {
      await sleep(250);
      block(1_400);
      await sleep(300);
      expect(lines.length).to.eq(1);
      expect(lines[0].f.ms).to.be.within(1_350, 1_800);
      expect(lines[0].f.mainCpuMs).to.be.below(150);
    } finally { w.stop(); }
  });

  it("nothing under the threshold, and at most maxPerHour lines", async () => {
    const lines: Line[] = []; const w = holdWatch({ log: (msg, f) => lines.push({ msg, f }), maxPerHour: 1 });
    try {
      await sleep(250);
      spin(600); await sleep(200);
      expect(lines.length).to.eq(0);
      spin(1_200); await sleep(200);
      spin(1_200); await sleep(200);
      expect(lines.length).to.eq(1);
    } finally { w.stop(); }
  });
});
