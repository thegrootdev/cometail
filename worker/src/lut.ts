// Address lookup tables for wide ladders. A 50-bin `route` touches up to 50 bin arrays plus
// the vault's static accounts; that exceeds a legacy transaction, so the keeper keeps one
// lookup table per vault, extends it with new bin arrays as ladders move, and sends `route`
// and `settle` as v0 transactions when the table is in play. Table addresses are cached in
// a local JSON file (COMETAIL_LUT_CACHE); losing the cache only means a new table.
import { AddressLookupTableAccount, AddressLookupTableProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { log, sendTx } from "./tx";

const CACHE = process.env.COMETAIL_LUT_CACHE || path.join(os.homedir(), ".config", "cometail", "lookup-tables.json");

function readCache(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}
function writeCache(c: Record<string, string>) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(c, null, 2) + "\n");
}

export class LookupTables {
  constructor(readonly connection: Connection, readonly payer: Keypair, readonly dryRun: boolean) {}

  /** Returns the vault's table containing at least `wanted`, creating or extending it as needed. */
  async ensure(vault: PublicKey, wanted: PublicKey[]): Promise<AddressLookupTableAccount | null> {
    const cache = readCache();
    let address = cache[vault.toBase58()] ? new PublicKey(cache[vault.toBase58()]) : null;
    let table = address ? (await this.connection.getAddressLookupTable(address)).value : null;
    if (!table) {
      const slot = await this.connection.getSlot("finalized");
      const [ix, addr] = AddressLookupTableProgram.createLookupTable({ authority: this.payer.publicKey, payer: this.payer.publicKey, recentSlot: slot });
      const r = await sendTx({ connection: this.connection, payer: this.payer, ixs: [ix], cu: 50_000, dryRun: this.dryRun, label: `lut.create ${vault.toBase58()}` });
      if (!r.ok || this.dryRun) return null;
      cache[vault.toBase58()] = addr.toBase58();
      writeCache(cache);
      address = addr;
      table = (await this.connection.getAddressLookupTable(addr)).value;
      if (!table) return null;
    }
    const have = new Set(table.state.addresses.map((a) => a.toBase58()));
    const missing = wanted.filter((k) => !have.has(k.toBase58()));
    if (missing.length === 0) return table;
    if (table.state.addresses.length + missing.length > 256) { log("lookup table full; a fresh one next pass", { vault }); delete cache[vault.toBase58()]; writeCache(cache); return null; }
    for (let i = 0; i < missing.length; i += 20) {
      const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: address!, authority: this.payer.publicKey, payer: this.payer.publicKey, addresses: missing.slice(i, i + 20) });
      const r = await sendTx({ connection: this.connection, payer: this.payer, ixs: [ix], cu: 50_000, dryRun: this.dryRun, label: `lut.extend ${vault.toBase58()} +${Math.min(20, missing.length - i)}` });
      if (!r.ok) return null;
    }
    // a table extended in this slot cannot be used until the next slot; the caller retries then
    const fresh = (await this.connection.getAddressLookupTable(address!)).value;
    return fresh && fresh.state.addresses.length >= have.size + missing.length ? fresh : null;
  }
}
