// The box has no IPv6 route, and every outbound lookup asked for A and AAAA; a lost answer to either half held the
// lookup for glibc's 5 s retry (spike 228). worker/src/ipv4.ts: a lookup that names no family asks for IPv4 only, in
// every call form, also the one fetch makes; a caller that asks for IPv6 still gets it. "localhost" is in /etc/hosts
// as both ::1 and 127.0.0.1, so these run offline.
import { expect } from "chai";
import dns from "dns";
import http from "http";
import type { AddressInfo } from "net";
import { ipv4Lookups } from "../../worker/src/ipv4";

const all = (o: object) => new Promise<dns.LookupAddress[]>((res, rej) => dns.lookup("localhost", { all: true, ...o }, (e, a) => (e ? rej(e) : res(a))));
const families = (a: dns.LookupAddress[]) => [...new Set(a.map((x) => x.family))].sort();

describe("IPv4-only outbound lookups (spike 228)", () => {
  it("installed on import: no family, or family 0, gives IPv4 only; IPv6 asked by name still answers", async () => {
    expect(families(await all({}))).to.deep.eq([4]);
    expect(families(await all({ family: 0, hints: dns.ADDRCONFIG }))).to.deep.eq([4]);
    expect(families(await all({ family: 6 }))).to.deep.eq([6]);
    const one = await new Promise<number>((res) => dns.lookup("localhost", (_e, _a, f) => res(f)));
    expect(one).to.eq(4);
    const num = await new Promise<number>((res) => dns.lookup("localhost", 0, (_e, _a, f) => res(f)));
    expect(num).to.eq(4);
    expect(families(await dns.promises.lookup("localhost", { all: true }))).to.deep.eq([4]);
  });

  it("without it both families come back (the case it replaces), and it can be put back", async () => {
    const restore = ipv4Lookups(); restore();
    try { expect(families(await all({}))).to.deep.eq([4, 6]); } finally { ipv4Lookups(); }
    expect(families(await all({}))).to.deep.eq([4]);
  });

  it("fetch resolves through it: the lookup it makes asks for IPv4", async () => {
    const seen: unknown[] = [];
    const restore = ipv4Lookups(); restore();
    const original = dns.lookup;
    (dns as any).lookup = function (host: string, o: any, cb: any) { if (host === "localhost") seen.push(typeof o === "object" ? o.family : o); return (original as any).call(this, host, o, cb); };
    ipv4Lookups();
    const server = http.createServer((_q, r) => r.end("ok")).listen(0, "127.0.0.1");
    try {
      await new Promise((r) => server.once("listening", r));
      const port = (server.address() as AddressInfo).port;
      const r = await fetch(`http://localhost:${port}/`);
      expect(await r.text()).to.eq("ok");
      expect(seen.length).to.be.greaterThan(0);
      expect(seen.every((f) => f === 4)).to.eq(true);
    } finally {
      server.close();
      ipv4Lookups()(); (dns as any).lookup = original; ipv4Lookups();
    }
  });
});
