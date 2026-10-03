import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { CometailClient, ApiError, FeedGapError, decodeFrame } from '../dist/index.js';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const workerRequire = createRequire(new URL('../../../worker/package.json', import.meta.url));

// Load real worker serializers, price math and persistence. Chain readers are unused here;
// supply their public program constants without opening RPC or loading transaction builders.
function loadWorker(options = {}) {
  const cache = new Map();
  const priceFetch = options.fetch ?? (async () => new Response(JSON.stringify({So11111111111111111111111111111111111111112:{usdPrice:150}})));
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const source = fs.readFileSync(new URL(`../../../worker/src/${name}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const exports = {};cache.set(name,exports);
    vm.runInNewContext(code, {exports,require(name){
      if(name==='./tx') return {log(){}};
      if(name==='./chain') {const {PublicKey}=workerRequire('@solana/web3.js');return {DBC_PROGRAM_ID:new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'),DAMM_V2_PROGRAM_ID:new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')};}
      return name.startsWith('./') ? load(name.slice(2)) : workerRequire(name);
    },fetch:priceFetch,URL,AbortSignal,Date:options.Date ?? Date,Buffer,console,process,setTimeout,clearTimeout,setInterval,clearInterval});
    return exports;
  }
  return {api:load('api'),feed:load('feed'),openStore:url=>load('store').openStore(url)};
}

// Exercise the actual worker's HTTP serialization with deterministic store and price inputs.
// No database, public RPC, wallet or external network access is involved.
test('SDK consumes current worker route envelopes, nullable values and all coverage states', async () => {
  const {api:exports} = loadWorker();
  const mint='11111111111111111111111111111111', quote='So11111111111111111111111111111111111111112';
  const token={mint,decimals:6,name:'Contract fixture',symbol:'TEST',imageUrl:null,metadataUri:null,metadataStatus:'missing',creator:mint,custody:'wallet',config:mint,tokenKind:'plain',dbcPool:mint,dammPool:null,quoteMint:quote,vault:null,stage:'bonding',priceSol:'0.001',priceSource:'curve',priceAtMs:100,totalSupplyRaw:'9007199254740993',quoteRaisedLamports:'10',targetLamports:'100',progressBps:1000,holders:null,holdersAtMs:null,liquidityLamports:'10',liquidityBasis:'curve-quote-reserve',links:null,volume24hLamports:'1000',buys24h:1,sells24h:0,volumeComplete:false,createdAtMs:null,updatedAt:100};
  const sky={pool:mint,config:mint,baseMint:mint,quoteMint:quote,creator:mint,custody:'wallet',claimableLamports:'9',realizedEstimateLamports:'1',tradingFeeLamports:'10'};
  const vault={vault:mint,data:{stMint:mint,depositor:mint,accounting:{},live:{ladder:null}},updatedAt:100};
  const ev={signature:'abc',idx:0,slot:10,blockTime:null,name:'unwound',vault:mint,data:{incomeReturned:'9007199254740993'}};
  const trade={signature:'abc',idx:0,slot:10,blockTime:null,pool:mint,vault:mint,trader:mint,traderKind:'authority',buy:true,amountIn:'100',amountOut:'200'};
  let cursors=[],scanned=100;
  const store={listTokens:async()=>[token],getToken:async k=>k===mint?token:null,listSky:async()=>[sky],listVaults:async()=>[vault],getVault:async()=>vault,listStreams:async()=>[{stream:mint,data:{pool:mint,isOwn:false}}],listAllStreams:async()=>[],listEvents:async()=>[ev],listEventsSince:async()=>[],listTrades:async()=>[trade],listTradesByPools:async()=>[trade],listPoolCursors:async()=>cursors,observedSlot:async()=>10,getMeta:async()=>scanned};
  const server = await exports.startApi(store,{host:'127.0.0.1',port:0,origins:[],ratePerMinute:1000,plainConfigs:[mint],cluster:'devnet'});
  const api = new CometailClient({baseUrl:`http://127.0.0.1:${server.address().port}`});
  try {
    assert.equal((await api.tokens()).coverage.status,'complete');
    cursors=[{key:mint,cursor:{status:'pending'}}];assert.equal((await api.tokens()).coverage.status,'partial');
    cursors=[];scanned=0;assert.equal((await api.tokens()).coverage.status,'stale');
    const t=await api.token(mint);assert.equal(t.data.market.totalSupplyRaw,token.totalSupplyRaw);assert.equal(t.data.holders.count,null);assert.equal(t.solUsd.valuationBasis,'reference');
    assert.equal((await api.trades(mint)).data.trades[0].baseAmountRaw,null);
    assert.equal((await api.sky()).streams[0].estimates[0].source,'estimate');
    assert.equal((await api.vaults()).vaults[0].stToken.name,token.name);
    assert.equal((await api.vault(mint)).events[0].data.incomeReturned,'9007199254740993');
    assert.equal((await api.events()).events[0].name,'unwound');
    assert.equal((await api.metrics()).plainLaunches.volumeEstimateLamports.independent,'1250');
    assert.equal((await api.prices()).solUsd,150);assert.equal((await api.health()).ok,true);
    token.quoteMint=mint;token.quoteDecimals=6;token.priceQuote='0.001234567891';token.priceSol=null;
    trade.quoteMint=mint;trade.quoteDecimals=6;trade.executionPriceQuote='0.001234567891';trade.executionPriceSol=null;
    const foreign=(await api.token(mint)).data;
    assert.equal(foreign.market.priceQuote,token.priceQuote);assert.equal(foreign.market.priceSol,null);
    assert.equal(foreign.market.quoteMint,mint);assert.equal(foreign.market.quoteDecimals,6);
    assert.equal(foreign.market.quoteUsd.status,'missing');assert.equal(foreign.market.quoteUsd.value,null);assert.equal(foreign.market.fdvUsd,null);
    const foreignTrade=(await api.trades(mint)).data.trades[0];
    assert.equal(foreignTrade.quoteMint,mint);assert.equal(foreignTrade.quoteDecimals,6);assert.equal(foreignTrade.executionPriceQuote,trade.executionPriceQuote);assert.equal(foreignTrade.executionPriceSol,null);
    token.quoteMint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const stable=(await api.token(mint)).data;
    assert.equal(stable.market.quoteUsd.value,1);assert.equal(stable.market.quoteUsd.status,'fresh');assert.notEqual(stable.market.fdvUsd,null);
    assert.match(stable.estimates.find(e=>e.path==='market.fdvUsd').basis,/quote-to-USD/);
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
});

// Replay and sockets use actual worker serialization and transport, with an in-memory Store.
test('SDK consumes all worker feed kinds, replay envelope, resume sentinel and real socket controls', async () => {
  const {api:worker,feed} = loadWorker();
  const mint='11111111111111111111111111111111', raw='9007199254740993';
  const names=['harvested','routed','settled','cashedOut','unwound','streamWithdrawn'];
  const events=names.map((name,i)=>({name,slot:10+i,idx:0,signature:'abc'+i,vault:mint,data:name==='unwound'?{stMint:mint,dbcPool:mint,incomeReturned:raw,launchedAt:'1',unwoundAt:'2'}:{}}));
  const rows=[...feed.feedFromEvents(events),...feed.feedFromTrades([{slot:16,idx:0,signature:'trade',pool:mint,vault:null,buy:true,trader:mint,traderKind:'feePayer'}],()=>null),...feed.feedFromTokens(new Map(),[{mint,name:'Test',symbol:'TEST',imageUrl:null,creator:mint,config:mint,dbcPool:mint,dammPool:null,quoteMint:mint,tokenKind:'plain',stage:'graduated',vault:null,updatedAt:100}],17)];
  for(const r of rows) assert.equal(decodeFrame(JSON.parse(JSON.stringify(feed.rowFrame('devnet',r)))).type,r.type);
  const store={oldestFeed:async()=>rows[0],headFeed:async()=>rows.at(-1),listFeedSince:async(cursor,limit)=>rows.filter(r=>!cursor||feed.compareCursor(r,cursor)>0).slice(0,limit),listPoolCursors:async()=>[],observedSlot:async()=>17,getMeta:async()=>100};
  const server=await worker.startApi(store,{host:'127.0.0.1',port:0,origins:[],ratePerMinute:1000,cluster:'devnet'});
  const client=new CometailClient({baseUrl:`http://127.0.0.1:${server.address().port}`});
  const subscriptions=[];
  const until=async(predicate)=>{for(let n=0;n<300;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Feed did not reach expected state');};
  try {
    let expired;try{await client.replay({since:'1:0:abc'});}catch(e){expired=e;}
    assert.equal(expired instanceof ApiError,true);assert.equal(expired.status,410);
    const resume=expired.body.resume;assert.equal(resume,'9:999999999:~');
    const first=await client.replay({since:resume,limit:2});assert.equal(first.type,'replay');assert.equal(first.cluster,'devnet');assert.equal(first.schemaVersion,1);assert.equal(first.events.length,2);assert.equal(first.nextCursor,'11:0:abc1');
    const replay=[];for await(const e of client.replayAll(resume))replay.push(e);
    assert.equal(replay.length,9);assert.equal(replay.find(e=>e.type==='unwind').data.incomeReturned,raw);
    assert.equal(replay.find(e=>e.type==='trade').data.baseAmountRaw,null);assert.equal(replay.find(e=>e.type==='graduation').data.signature,undefined);
    const seen=[],controls=[],errors=[];
    const sub=client.feed({since:resume,heartbeatTimeoutMs:0,reconnect:false,onEvent:e=>{seen.push(e)},onControl:c=>controls.push(c),onError:e=>errors.push(e)});subscriptions.push(sub);
    await until(()=>controls.some(c=>c.type==='coverage')||errors.length);
    assert.equal(errors.length,0);assert.equal(seen.length,9);assert.equal(sub.cursor,replay.at(-1).cursor);
    assert.equal(controls.find(c=>c.type==='hello').schemaVersion,1);
    const live=feed.feedFromEvents([{name:'harvested',slot:18,idx:0,signature:'live',vault:mint,data:{stream:mint,toIncome:raw}}])[0];
    feed.feedBus.emit('event',live);await until(()=>seen.length===10||errors.length);
    assert.equal(errors.length,0);assert.equal(seen.at(-1).data.incomeLamports,raw);
    let gap;const expiredSub=client.feed({since:'1:0:abc',heartbeatTimeoutMs:0,reconnect:false,onEvent(){assert.fail('Gap must stop before replay');},onError:e=>{gap=e}});subscriptions.push(expiredSub);
    await until(()=>gap);assert.equal(gap instanceof FeedGapError,true);assert.equal(gap.resume,resume);assert.equal(expiredSub.cursor,'1:0:abc');assert.equal(expiredSub.closed,true);
  } finally {
    for(const sub of subscriptions)sub.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});


test('worker ranks exact cross-quote USD volumes and never values stale or missing quotes', async () => {
  let now=Date.now(),available=true;
  const {api:worker}=loadWorker({Date:class extends Date {static now(){return now}},fetch:async()=>new Response(JSON.stringify({So11111111111111111111111111111111111111112:{usdPrice:100}}),{status:available?200:503})});
  const sol='So11111111111111111111111111111111111111112',usd='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const token=(mint,quoteMint,quoteDecimals,volume24hLamports,createdAtMs)=>({mint,name:mint,symbol:'FIX',creator:'owner',decimals:6,quoteMint,quoteDecimals,volume24hLamports,createdAtMs,updatedAt:createdAtMs,totalSupplyRaw:'1000000',priceSol:quoteMint===sol?'1':null,priceQuote:'1',quoteRaisedLamports:'0',targetLamports:'100',progressBps:0,stage:'bonding',volumeComplete:true});
  let rows=[];
  const store={listTokens:async()=>rows,listPoolCursors:async()=>[],observedSlot:async()=>1,getMeta:async()=>now};
  const server=await worker.startApi(store,{host:'127.0.0.1',port:0,origins:[],ratePerMinute:1000,cluster:'devnet'});
  const api=new CometailClient({baseUrl:`http://127.0.0.1:${server.address().port}`});
  const ranked=()=>api.tokens({sort:'volume24h'});
  try {
    rows=[token('sol',sol,9,'1000000000',1),token('usd',usd,6,'200000000',2)];
    const fresh=await ranked();assert.equal(fresh.data.tokens[0].identity.mint,'usd');assert.equal(fresh.data.volumeRanking.basis,'quote-usd-v1');
    rows=[token('older-high-raw','stock-A',8,'1000000000000000',1),token('newer-low-raw','stock-B',6,'1',2)];
    assert.equal((await ranked()).data.tokens[0].identity.mint,'newer-low-raw');
    rows=[token('lower',usd,6,'9007199254740992',2),token('higher',usd,6,'9007199254740993',1)];
    assert.equal((await ranked()).data.tokens[0].identity.mint,'higher');
    rows=[token('stale-sol',sol,9,'1000000000000000',1),token('fresh-usd',usd,6,'1000000',2)];
    now+=700000;available=false;
    const stale=await ranked(),staleToken=stale.data.tokens.find(t=>t.identity.mint==='stale-sol');
    assert.equal(stale.data.tokens[0].identity.mint,'fresh-usd');assert.equal(stale.solUsd.status,'stale');
    assert.equal(staleToken.market.quoteUsd.status,'missing');assert.equal(staleToken.market.fdvUsd,null);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});


test('persisted foreign and native trades retain their units through the HTTP route', async () => {
  const {api:worker,openStore}=loadWorker(),store=openStore('sqlite::memory:');
  await store.init();
  let server;
  const cases=[
    {mint:'B'.repeat(32),quoteMint:'9YSXk1YcKXHcTodgu4MuvKdRu7kW64Af61cKERH2Wtcd',quoteDecimals:6,base:'2469905353851',quote:'5000000',price:'0.000002024369'},
    {mint:'C'.repeat(32),quoteMint:'BN6zukGJEUGDCBgjYJxyDNs7KubMKeJVjS6RyfNBcXAN',quoteDecimals:8,base:'144834089158181',quote:'50000000',price:'0.000000003452'},
    {mint:'D'.repeat(32),quoteMint:'So11111111111111111111111111111111111111112',quoteDecimals:9,base:'9007199254740993',quote:'9007199254740993',price:'0.001'},
  ];
  try {
    await store.upsertTokens(cases.map(t=>({...t,decimals:6,dbcPool:t.mint,dammPool:null,volume24hLamports:t.quote,updatedAt:100,priceQuote:'999'})));
    // Insertion deliberately follows the real persistence boundary. No fake Store object:
    // the table stores raw execution amounts while quote identity is recovered from its token.
    await store.insertTrades(cases.map((t,i)=>({signature:'stored-'+i,idx:i,slot:10+i,blockTime:100,pool:t.mint,vault:'',trader:t.mint,traderKind:'authority',buy:i!==1,amountIn:i===1?t.base:t.quote,amountOut:i===1?t.quote:t.base,venue:'curve',baseAmountRaw:t.base,quoteAmountLamports:t.quote,executionPriceSol:null,quoteMint:t.quoteMint,quoteDecimals:t.quoteDecimals,executionPriceQuote:t.price})));
    server=await worker.startApi(store,{host:'127.0.0.1',port:0,origins:[],ratePerMinute:1000,cluster:'devnet'});
    const client=new CometailClient({baseUrl:`http://127.0.0.1:${server.address().port}`});
    for(const t of cases){
      const r=(await client.trades(t.mint)).data.trades[0];
      assert.equal(r.quoteMint,t.quoteMint);assert.equal(r.quoteDecimals,t.quoteDecimals);
      assert.equal(r.quoteAmountLamports,t.quote);assert.equal(r.baseAmountRaw,t.base);
      assert.equal(r.executionPriceQuote,t.price,'historical execution, never current token price');
      assert.equal(r.executionPriceSol,t.quoteDecimals===9?t.price:null);
    }
  } finally {if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await store.close();}
});
