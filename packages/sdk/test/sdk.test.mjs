import test from 'node:test';
import assert from 'node:assert/strict';
import { CometailClient, FeedSubscription, ApiError, ProtocolError, FeedGapError, decodeFrame, compareCursors } from '../dist/index.js';
const mint='11111111111111111111111111111111';
const frame=(cursor='10:0:abc', extra={})=>({schemaVersion:1,cluster:'devnet',type:'harvest',cursor,observedSlot:10,generatedAtMs:100,provenance:{source:'chain',signature:'abc',slot:10},data:{vault:mint,stream:mint,incomeLamports:'9007199254740993',signature:'abc'},...extra});
const token={identity:{mint,decimals:6,name:'Comet',symbol:'COMET',imageUrl:null,metadataUri:null,metadataStatus:'missing',creator:mint,custody:'wallet',createdAtMs:null,dbcPool:mint,dammPool:null,quoteMint:mint,tokenKind:'plain',config:mint,vault:null,stage:'bonding',links:null},market:{priceSol:null,priceSource:null,priceAtMs:10,totalSupplyRaw:'9007199254740993',circulatingSupplyRaw:null,fdvUsd:'100',marketCapUsd:null,valuationBasis:'fdv',liquidityLamports:'10000',liquidityBasis:'damm-quote-x2'},volume24h:{lamports:'0',buys:0,sells:0,windowEndMs:10,windowStartMs:0,complete:false,status:'partial'},holders:{count:null,countedAtMs:null,status:'missing',definition:'owners'},bonding:{progressBps:0,quoteRaisedLamports:'0',targetLamports:'1',migrationStage:'bonding'},updatedAtMs:10};
const envelope=data=>({schemaVersion:1,cluster:'devnet',generatedAtMs:100,observedSlot:null,coverage:{status:'partial',pendingPools:2,lastSuccessfulAtMs:null},solUsd:null,data});
const clientWith=fetch=>new CometailClient({baseUrl:'https://example.com',fetch});
const json=(v,status=200,headers={})=>new Response(JSON.stringify(v),{status,headers});
const turn=()=>new Promise(resolve=>setTimeout(resolve,5));
class Socket extends EventTarget { constructor(url){super();this.url=url;this.closed=false;} send(v){this.dispatchEvent(new MessageEvent('message',{data:typeof v==='string'?v:JSON.stringify(v)}));} open(){this.dispatchEvent(new Event('open'));} close(){this.closed=true;this.dispatchEvent(new Event('close'));} }
const setup=(options={})=>{const sockets=[],events=[],errors=[],controls=[];const sub=new CometailClient().feed({socketFactory:url=>{const s=new Socket(url);sockets.push(s);return s},onEvent:e=>{events.push(e)},onError:e=>errors.push(e),onControl:e=>controls.push(e),heartbeatTimeoutMs:0,retryDelayMs:1,maxRetryDelayMs:4,...options});return {sub,sockets,events,errors,controls}};

test('token envelope preserves raw precision, coverage, unknown fields, provenance and estimate labels',async()=>{
 const t={...token,provenance:{source:'indexer',scannedAtMs:8},future:'preserved'};
 const c=clientWith(async()=>json(envelope({tokens:[t],total:1,nextCursor:null,sort:'newest',stage:'all'})));
 const r=await c.tokens();assert.equal(r.data.tokens[0].market.totalSupplyRaw,'9007199254740993');assert.equal(r.coverage.status,'partial');assert.equal(r.observedSlot,null);assert.equal(r.solUsd,null);assert.equal(r.data.tokens[0].future,'preserved');assert.equal(r.data.tokens[0].provenance.scannedAtMs,8);assert.deepEqual(r.data.tokens[0].estimates.map(e=>e.path),['market.fdvUsd','market.liquidityLamports']);assert.equal(r.provenance.source,'indexer');
});
test('all REST routes keep exact wire paths/shapes and identify estimates',async()=>{
 const calls=[];const c=clientWith(async url=>{const u=new URL(url);calls.push(u.pathname+u.search);switch(u.pathname){
 case '/api/sky':return json({streams:[{baseMint:mint,claimableLamports:'1',realizedEstimateLamports:'2',realized7dLamports:null}]});
 case '/api/vaults':return json({vaults:[{vault:mint,data:{},updatedAt:1,stToken:null}]});
 case '/api/vaults/'+mint:return json({vault:mint,data:{},streams:[{stream:mint,data:{},token:null}],events:[{signature:'a',slot:3,data:{}}],trades:[{signature:'b',slot:4,amountIn:'999',buy:true}]});
 case '/api/events':return json({schemaVersion:1,cluster:'devnet',type:'replay',generatedAtMs:100,events:[{signature:'a',slot:3,data:{}}]});
 case '/api/tokens/'+mint:return json(envelope(token));
 case '/api/tokens/'+mint+'/trades':return json(envelope({trades:[{signature:'a',slot:3,baseAmountRaw:null,quoteAmountLamports:null}],nextCursor:null}));
 case '/api/metrics':return json({generatedAt:10,incomplete:true,plainLaunches:{volumeEstimateLamports:{independent:'125',demo:'0',unattributed:'0'}}});
 case '/api/prices':return json({solUsd:120,source:'jupiter',at:5,quotes:{future:'kept'}});
 case '/api/health':return json({ok:true,service:'cometail-indexer',time:10});default:throw Error(u.pathname)}});
 assert.equal((await c.sky({limit:2})).streams[0].estimates[0].source,'estimate');assert.equal((await c.vaults()).vaults[0].provenance.source,'indexer');const v=await c.vault(mint);assert.equal(v.streams[0].provenance.source,'indexer');assert.equal(v.trades[0].amountIn,'999');assert.equal((await c.events()).events[0].provenance.source,'indexer');await c.token(mint);assert.equal((await c.trades(mint)).data.trades[0].baseAmountRaw,null);assert.equal((await c.metrics()).estimates[0].path,'plainLaunches.volumeEstimateLamports');assert.equal((await c.prices()).quotes.future,'kept');assert.equal((await c.health()).ok,true);assert.equal(calls.length,9);
});
test('query encoding, origin/address/limit validation',async()=>{
 let url;const c=clientWith(async u=>{url=u;return json(envelope({tokens:[],total:0,nextCursor:null,sort:'volume24h',stage:'all'}))});await c.tokens({q:'space & #',cursor:'cursor/?',limit:100});assert.equal(new URL(url).searchParams.get('q'),'space & #');assert.equal(new URL(url).searchParams.get('cursor'),'cursor/?');await assert.rejects(c.tokens({limit:101}),RangeError);await assert.rejects(c.token('../metrics'),TypeError);assert.throws(()=>new CometailClient({baseUrl:'https://user:password@localhost'}),TypeError);
});
test('HTTP failures retain status/Retry-After; HTML and unsupported schema fail clearly',async()=>{
 await assert.rejects(clientWith(async()=>json({error:'rate limited'},429,{'retry-after':'10'})).prices(),e=>e instanceof ApiError&&e.status===429&&e.retryAfter==='10');
 await assert.rejects(clientWith(async()=>new Response('<html>outage</html>',{status:503})).prices(),e=>e instanceof ApiError&&e.status===503);
 await assert.rejects(clientWith(async()=>new Response('<html>wrong host</html>')).prices(),ProtocolError);
 await assert.rejects(clientWith(async()=>json({...envelope({}),schemaVersion:2})).token(mint),ProtocolError);
 await assert.rejects(clientWith(async()=>json({streams:{}})).sky(),ProtocolError);
});
test('caller cancellation and bounded timeout abort active requests',async()=>{
 const fetch=async(_url,{signal})=>new Promise((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});
 const controller=new AbortController(),c=new CometailClient({fetch,timeoutMs:1000});const p=c.prices({signal:controller.signal});controller.abort(new Error('cancelled'));await assert.rejects(p,/cancelled/);
 await assert.rejects(new CometailClient({fetch,timeoutMs:5}).prices(),/timed out/);
});
test('feed replay pages numerically, preserves evidence, and does not skip same-slot events',async()=>{
 const calls=[];const c=clientWith(async u=>{calls.push(new URL(u).searchParams.get('since'));return calls.length===1?json({schemaVersion:1,cluster:'devnet',type:'replay',generatedAtMs:100,events:[frame('9:1:abc'),frame('10:0:abc')],nextCursor:'10:0:abc'}):json({schemaVersion:1,cluster:'devnet',type:'replay',generatedAtMs:100,events:[frame('10:0:abd')],nextCursor:null})});const got=[];for await(const e of c.replayAll('9:0:abc'))got.push(e.cursor);assert.deepEqual(got,['9:1:abc','10:0:abc','10:0:abd']);assert.deepEqual(calls,['9:0:abc','10:0:abc']);assert.equal(compareCursors('9:0:abc','10:0:abc'),-1);
});
test('replay rejects nonadvancing/misordered cursors and surfaces retention 410',async()=>{
 await assert.rejects(clientWith(async()=>json({schemaVersion:1,cluster:'devnet',type:'replay',generatedAtMs:100,events:[frame()],nextCursor:'11:0:abc'})).replay(),ProtocolError);
 await assert.rejects(clientWith(async()=>json({schemaVersion:1,cluster:'devnet',type:'replay',generatedAtMs:100,events:[frame('10:0:abc'),frame('9:0:abc')],nextCursor:null})).replay(),ProtocolError);
 await assert.rejects(clientWith(async()=>json({error:'cursor expired'},410)).replay({since:'1:0:abc'}),e=>e instanceof ApiError&&e.status===410);
});
test('all seven event types validate; estimates require basis and exact raw strings',()=>{
 const cases={launch:{mint,name:'X',symbol:'X',imageUrl:null,creator:mint,config:mint,dbcPool:mint,tokenKind:'plain'},trade:{mint,pool:mint,venue:'curve',side:'buy',baseAmountRaw:'1',quoteAmountLamports:'2',executionPriceSol:null,trader:mint,signature:'abc'},graduation:{mint,dbcPool:mint,dammPool:mint,signature:'abc'},harvest:frame().data,bid:{vault:mint,order:mint,bins:2,grossLamports:'1',signature:'abc'},fill:{vault:mint,order:mint,burnedStRaw:'1',unfilledLamports:'2',signature:'abc'},cashout:{vault:mint,depositorLamports:'1',signature:'abc'}};
 for(const[type,data]of Object.entries(cases))assert.equal(decodeFrame(frame(undefined,{type,data})).type,type);
 assert.throws(()=>decodeFrame(frame(undefined,{provenance:{source:'estimate'}})),ProtocolError);
 assert.equal(decodeFrame(frame(undefined,{provenance:{source:'estimate'},data:{...frame().data,basis:'aggregate fees'}})).data.basis,'aggregate fees');
 assert.throws(()=>decodeFrame(frame(undefined,{data:{...frame().data,incomeLamports:9007199254740992}})),ProtocolError);
 assert.throws(()=>decodeFrame(frame(undefined,{schemaVersion:2})),ProtocolError);
});
test('hello is not an acknowledgement; reconnect resumes last delivered event and suppresses earlier replay',async()=>{
 const x=setup({since:'9:0:abc'});try{x.sockets[0].open();x.sockets[0].send({type:'hello',cursor:'999:0:abc',retentionSlots:100});assert.equal(x.sub.cursor,'9:0:abc');x.sockets[0].send(frame('10:0:abc'));await turn();assert.equal(x.sub.cursor,'10:0:abc');x.sockets[0].close();await turn();assert.equal(new URL(x.sockets[1].url).searchParams.get('since'),'10:0:abc');x.sockets[1].send(frame('10:0:abc'));x.sockets[1].send(frame('11:0:abc'));await turn();assert.equal(x.events.length,2);assert.equal(x.sub.cursor,'11:0:abc');assert.equal(x.errors.length,0)}finally{x.sub.close()}
});
test('slow consumer delivery is ordered; disconnect waits for acknowledged queue before reconnect',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),seen=[];const x=setup({since:'9:0:abc',onEvent:async e=>{if(e.cursor==='10:0:abc')await gate;seen.push(e.cursor)}});
 try{x.sockets[0].send(frame('10:0:abc'));x.sockets[0].send(frame('11:0:abc'));x.sockets[0].close();await turn();assert.equal(x.sockets.length,1);assert.equal(x.sub.cursor,'9:0:abc');release();await turn();await turn();assert.deepEqual(seen,['10:0:abc','11:0:abc']);assert.equal(new URL(x.sockets[1].url).searchParams.get('since'),'11:0:abc')}finally{x.sub.close()}
});
test('consumer failure stops without advancing cursor or losing a resumable event',async()=>{
 const x=setup({since:'9:0:abc',onEvent:async()=>{throw Error('store unavailable')}});x.sockets[0].send(frame());await turn();assert.equal(x.sub.closed,true);assert.equal(x.sub.cursor,'9:0:abc');assert.match(x.errors[0].message,/store unavailable/);
});
test('malformed/future/foreign-cluster/out-of-order frames fail closed',async()=>{
 for(const payload of ['{broken',frame(undefined,{schemaVersion:2}),frame(undefined,{cluster:'mainnet-beta'})]){const x=setup({cluster:'devnet'});x.sockets[0].send(payload);await turn();assert.equal(x.sub.closed,true);assert.equal(x.sub.cursor,undefined);assert.equal(x.errors.length,1)}
 const x=setup();x.sockets[0].send(frame('10:0:abc'));await turn();x.sockets[0].send(frame('9:0:abc'));assert.equal(x.sub.closed,true);assert.equal(x.sub.cursor,'10:0:abc');
});
test('control coverage delivered, abort stops reconnect, overflow bounded and heartbeat retries',async()=>{
 const controller=new AbortController(),x=setup({signal:controller.signal});x.sockets[0].send({type:'coverage',status:'partial',pendingPools:1,lastSuccessfulAtMs:null});assert.equal(x.controls[0].status,'partial');controller.abort();assert.equal(x.sub.closed,true);
 const y=setup({maxPendingEvents:1,onEvent:()=>new Promise(()=>{})});y.sockets[0].send(frame());y.sockets[0].send(frame('11:0:abc'));assert.equal(y.sub.closed,true);assert.equal(y.sub.cursor,undefined);
 const z=setup({heartbeatTimeoutMs:5,maxRetries:1});await new Promise(resolve=>setTimeout(resolve,25));assert.equal(z.sockets.length,2);assert.equal(z.sub.closed,true);
});

test('direct subscriptions reject invalid origins before opening a transport',()=>{
 for(const base of ['file:///tmp/feed','https://user:pass@localhost','https://example.com/path','https://example.com?x=1']) {
  let opened=false;
  assert.throws(()=>new FeedSubscription(base,{onEvent(){},socketFactory(){opened=true;throw Error('opened')}}),TypeError);
  assert.equal(opened,false);
 }
 assert.throws(()=>decodeFrame(frame(undefined,{type:'toString'})),ProtocolError);
});

test('retention gaps stop before hello or events without advancing the saved cursor',async()=>{
 const x=setup({since:'1:0:abc'});
 x.sockets[0].send({type:'gap',oldest:'10:0:abc',resume:'9:0:abc'});
 x.sockets[0].send({type:'hello',cursor:'99:0:abc',retentionSlots:100});
 x.sockets[0].send(frame());await turn();
 assert.equal(x.sub.closed,true);assert.equal(x.sub.cursor,'1:0:abc');assert.equal(x.events.length,0);
 assert.equal(x.controls[0].type,'gap');assert.equal(x.errors[0] instanceof FeedGapError,true);
 assert.equal(x.errors[0].resume,'9:0:abc');assert.equal(x.sockets.length,1);
 assert.throws(()=>decodeFrame({type:'gap',oldest:'10:0:abc',resume:'10:0:abc'}),ProtocolError);
 assert.throws(()=>decodeFrame({type:'gap',oldest:'10:0:abc',resume:'bad'}),ProtocolError);
});
test('unwind feed keeps exact returned balance and rejects a numeric or fractional amount',()=>{
 const event=frame(undefined,{type:'unwind',data:{vault:mint,stMint:mint,dbcPool:mint,incomeReturned:'9007199254740993',signature:'abc'}});
 assert.equal(decodeFrame(event).data.incomeReturned,'9007199254740993');
 for(const amount of [1,'1.5','-1'])assert.throws(()=>decodeFrame({...event,data:{...event.data,incomeReturned:amount}}),ProtocolError);
});
