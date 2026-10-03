import { CometailClient, type FeedEvent, type SocketLike } from '@cometail/sdk';

const api = new CometailClient({ fetch: globalThis.fetch });
const factory = (url: string): SocketLike => new WebSocket(url);
function consume(event: FeedEvent): void {
  if (event.type === 'bid') {
    const count: number = event.data.bins;
    const gross: string | null = event.data.grossLamports;
    void [count, gross];
    // @ts-expect-error Only fill events include burned stream tokens.
    event.data.burnedStRaw;
  }
  if (event.type === 'fill' && event.data.burnedStRaw !== null) {
    const burned: bigint = BigInt(event.data.burnedStRaw);
    void burned;
  }
}
async function example(): Promise<void> {
  const page = await api.tokens({ limit: 20, stage: 'all' });
  const raw: string = page.data.tokens[0]!.market.totalSupplyRaw;
  const quoteDecimals: number = page.data.tokens[0]!.market.quoteDecimals;
  const quoteUsd: number | null = page.data.tokens[0]!.market.quoteUsd.value;
  const replay = await api.replay();
  const replayType: "replay" = replay.type;
  void [quoteDecimals, quoteUsd, replayType];
  const source: 'chain' | 'indexer' | 'estimate' = page.data.tokens[0]!.provenance.source;
  const subscription = api.feed({ socketFactory: factory, onEvent: consume });
  const cursor: string | undefined = subscription.cursor;
  subscription.close();
  void [raw, source, cursor];
}
void example;
