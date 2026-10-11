// Token-page link previews (web/src/lib/server/preview.ts): a coin's own logo is named as the preview image only when it
// is one of our uploads on the media origin (https, a content-addressed webp, nothing appended); anything else is null,
// so the page falls back to the brand card.
import { expect } from "chai";
import { ownLogo } from "../../web/src/lib/server/preview";

const ORIGIN = "https://media.cometail.fun";
/** The same URL carrying a username (and password) in its authority. */
const withCredentials = (url: string, username: string, password: string) => { const u = new URL(url); u.username = username; u.password = password; return u.href; };
const KEY = "1f6f914b37f13aafbb1fdf564023d7eacca235b585757aa8532797f50cdeddc2";
describe("token preview image", () => {
  it("takes an upload from the media origin", () => {
    expect(ownLogo(`${ORIGIN}/${KEY}.webp`, ORIGIN)).eq(`${ORIGIN}/${KEY}.webp`);
    expect(ownLogo(`${ORIGIN}/${KEY}.webp`, `${ORIGIN}/`), "origin with a trailing slash").eq(`${ORIGIN}/${KEY}.webp`);
  });
  it("refuses everything else", () => {
    for (const url of [
      `https://media.cometail.fun.evil.example/${KEY}.webp`, `https://evil.example/${KEY}.webp`, `http://media.cometail.fun/${KEY}.webp`,
      `${ORIGIN}/${KEY}.json`, `${ORIGIN}/${KEY}.png`, `${ORIGIN}/x/${KEY}.webp`, `${ORIGIN}/${KEY.slice(1)}.webp`, `${ORIGIN}/${KEY.toUpperCase()}.webp`,
      `${ORIGIN}/${KEY}.webp?x=1`, `${ORIGIN}/${KEY}.webp#x`, withCredentials(`${ORIGIN}/${KEY}.webp`, "u", ""), withCredentials(`${ORIGIN}/${KEY}.webp`, "u", "p"),
      "ipfs://bafy/logo.png", "not a url", "",
    ]) expect(ownLogo(url, ORIGIN), url).eq(null);
    for (const v of [null, undefined, 42, {}]) expect(ownLogo(v, ORIGIN)).eq(null);
    expect(ownLogo(`${ORIGIN}/${KEY}.webp`, undefined), "no media origin configured").eq(null);
    expect(ownLogo(`${ORIGIN}/${KEY}.webp`, "not a url"), "a broken media origin").eq(null);
  });
});
