// The environment sky-quote.test.ts needs before web/src/lib/quotes.ts loads: mainnet, with $COMETAIL as the official mint.
process.env.NEXT_PUBLIC_CLUSTER = "mainnet-beta";
process.env.NEXT_PUBLIC_OFFICIAL_MINT = "z4Zr7wNGDYbmqsgW9hYHxSgtUFWxKsbwjRThzrdUkit";
export {};
