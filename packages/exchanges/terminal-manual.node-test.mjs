import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualPreview, registerManualTrading } from './terminal-manual.mjs';
import { defaultSettings, emptyJournal, atomicJson, readJson } from './terminal-trading-store.mjs';
import { cycle, ensureLeverage, makeProposal } from './terminal-execution.mjs';
import { createBitget } from './terminal-bitget.mjs';
import { createBitgetV3 } from './terminal-bitget-v3.mjs';
const now = Date.now();
const context = () => ({ equity: 1000, available: 1000, price: 100, quoteTime: Date.now(), positions: [], orders: [],
  account: { posMode: 'one_way_mode', marginMode: 'isolated', isolatedLongLever: '1', isolatedShortLever: '1' },
  rules: { step: 0.01, tick: 0.01, minSize: 0.01, minCost: 5, maxSize: 100, status: 'normal' } });
const state = () => ({ settings: defaultSettings(), connections: { demo: { revision: 'c1', credentials: {} }, live: { revision: 'c2', credentials: {} } }, journal: { ...emptyJournal(), updatedAt: Date.now() } });
const body = () => ({ environment: 'demo', connectionRevision: 'c1', symbol: 'BTC/USDT:USDT', action: 'open', side: 'long', orderType: 'limit', quantity: 0.5, limit: 100, leverage: 1, stopLossPct: 2, takeProfitPct: 4 });
test('manual preview enforces increments, margin, direction, connection, leverage cap, combined risk and daily loss without mutation', () => {
  const s = state(), c = context(), b = body(); const p = manualPreview(b, c, s);
  assert.equal(p.stop, 98); assert.equal(p.target, 104); assert.ok(p.id.length <= 32); assert.equal(s.journal.entries.length, 0);
  for (const change of [{ quantity: 0.501 }, { leverage: 21 }, { leverage: 0 }, { limit: 100.001 }, { connectionRevision: 'old' }, { stopLossPct: 0 }, { takeProfitPct: 51 }]) assert.throws(() => manualPreview({ ...b, ...change }, c, s));
  s.journal.entries.push({ environment: 'demo', symbol: 'SOLUSDT', status: 'open', riskAmount: 20 });
  assert.throws(() => manualPreview(b, c, s), /exposure|risk/); s.journal.entries = [];
  s.journal.days.demo = { date: new Date().toISOString().slice(0, 10), equity: 1100 };
  assert.throws(() => manualPreview(b, c, s), /Daily/);
});
test('manual closes are bounded by actual side position and reject pending opening exposure', () => {
  const s=state(), c=context(), b={ ...body(), action:'close' };
  assert.throws(() => manualPreview(b,c,s), /position/);
  c.positions=[{symbol:'BTCUSDT',holdSide:'long',total:'0.5'}];
  assert.equal(manualPreview(b,c,s).stop,undefined);
  assert.throws(() => manualPreview({...b,quantity:0.6},c,s), /quantity/);
  s.journal.entries=[{symbol:'BTCUSDT',environment:'demo',status:'resting'}];
  assert.throws(() => manualPreview(b,c,s), /working/);
});
test('both adapters send reduce-only side-correct limit/market orders and isolated leverage payloads', async () => {
  for (const factory of [createBitget, createBitgetV3]) {
    const calls=[]; const c=factory('demo',{apiKey:'key',secret:'secret',passphrase:'pass'},async(url,options)=>{calls.push({url,body:JSON.parse(options.body),headers:options.headers});return {ok:true,json:async()=>({code:'00000',data:{orderId:'1'}})};});
    for(const side of ['long','short']) for(const orderType of ['limit','market']) {
      await c.submit({...body(),id:'manual1',symbol:'BTCUSDT',action:'close',side,orderType});
      const call=calls.at(-1); assert.equal(call.body.side,side==='long'?'sell':'buy'); assert.equal(call.body.reduceOnly.toLowerCase(),'yes');
      assert.equal(call.body.orderType,orderType); assert.equal('price' in call.body,orderType==='limit'); assert.equal(call.headers.paptrading,'1');
      assert.equal(call.body.stopLoss,undefined); assert.equal(call.body.presetStopLossPrice,undefined);
    }
    await c.setLeverage({...body(),symbol:'BTCUSDT',leverage:20}); assert.equal(calls.at(-1).body.leverage,'20'); assert.match(calls.at(-1).url,/account\/set-leverage$/);
  }
});
test('leverage changes only without same-pair exposure and requires verified exchange state', async () => {
  const c=context(), e={...body(),symbol:'BTCUSDT',leverage:5}; let calls=0;
  const client={setLeverage:async()=>{calls++},context:async()=>c};
  await assert.rejects(ensureLeverage(client,e,c),/verification/); assert.equal(calls,1);
  c.positions=[{symbol:'BTCUSDT'}]; await assert.rejects(ensureLeverage(client,e,c),/exposure/); assert.equal(calls,1);
  c.positions=[]; client.setLeverage=async()=>{calls++;c.account.isolatedLongLever='5'};
  await ensureLeverage(client,e,c); assert.equal(calls,2);
});
test('durable manual confirmation serializes duplicates and never retries unknown outcomes', async () => {
  const dir=await mkdtemp(join(tmpdir(),'manual-trading-')), previous=process.env.TERMINAL_TRADING_PATH, oldControl=process.env.TERMINAL_CONTROL_PATH; process.env.TERMINAL_TRADING_PATH=dir; process.env.TERMINAL_CONTROL_PATH=join(dir,'control.json');
  try {
    const initial={...state(),directory:dir}; await atomicJson(join(dir,'journal.json'),initial.journal);
    const load=async()=>({...initial,journal:await readJson(join(dir,'journal.json'),null)});
    let submissions=0, leverageCalls=0;
    const client={context:async()=>context(),setLeverage:async()=>{leverageCalls++},submit:async()=>{submissions++;throw Error('timeout')}};
    const routes=new Map(),auth=()=>{};
    const app={get:(path,opts,fn)=>{assert.equal(opts.preHandler,auth);routes.set(path,fn)},post:(path,opts,fn)=>{assert.equal(opts.preHandler,auth);routes.set(path,fn)}};
    registerManualTrading(app,auth,load,()=>client);
    const call=async(name,body)=>routes.get('/api/terminal/trading/manual/'+name)({body},{code(status){return{send:payload=>({status,...payload})}}});
    const {preview}=await call('preview',body()); assert.equal(submissions,0); assert.equal(leverageCalls,0);
    const stale=await load();stale.journal.updatedAt=Date.now()-31000;await atomicJson(join(dir,'journal.json'),stale.journal);
    assert.equal((await call('confirm',{previewId:preview.id})).status,409);assert.equal(submissions,0);
    stale.journal.updatedAt=Date.now();await atomicJson(join(dir,'journal.json'),stale.journal);
    await atomicJson(process.env.TERMINAL_CONTROL_PATH,{paused:true});
    assert.equal((await call('confirm',{previewId:preview.id})).status,409);assert.equal(submissions,0);
    await atomicJson(process.env.TERMINAL_CONTROL_PATH,{paused:false});
    const results=await Promise.all([call('confirm',{previewId:preview.id}),call('confirm',{previewId:preview.id})]);
    assert.equal(submissions,1); assert.equal(results[0].entry.status,'unknown'); assert.equal(results.filter(r=>r.duplicate).length,1);
    assert.equal((await load()).journal.entries.length,1);
    const {preview:live}=await call('preview',{...body(),environment:'live',connectionRevision:'c2'});
    assert.equal((await call('confirm',{previewId:live.id})).status,400); assert.equal(submissions,1);
    await call('confirm',{previewId:live.id,liveAcknowledgement:'PLACE LIVE ORDER'});assert.equal(submissions,2);
  } finally {if(previous===undefined)delete process.env.TERMINAL_TRADING_PATH;else process.env.TERMINAL_TRADING_PATH=previous;if(oldControl===undefined)delete process.env.TERMINAL_CONTROL_PATH;else process.env.TERMINAL_CONTROL_PATH=oldControl;await rm(dir,{recursive:true,force:true});}
});
test('GTC orders rest, partial fills verify protection, cancel retains filled position and close orders never open reverse exposure', async () => {
  const s=state(), e={...manualPreview(body(),context(),s),status:'submitted'};s.journal.entries=[e];
  let detail={state:'live',baseVolume:'0'}, canceled=0, closed=0;
  const protection=[{symbol:'BTCUSDT',holdSide:'long',planStatus:'live',size:0.2,planType:'loss_plan',triggerPrice:98},{symbol:'BTCUSDT',holdSide:'long',planStatus:'live',size:0.2,planType:'profit_plan',triggerPrice:104}];
  const client={detail:async()=>detail,cancel:async()=>{canceled++},positions:async()=>[{symbol:'BTCUSDT',holdSide:'long',total:'0.2',posMode:'one_way_mode'}],protection:async()=>protection,close:async()=>{closed++}};
  const input={...s,commands:[],paused:true},deps={clientFor:()=>client,save:async()=>{},now:()=>now};
  await cycle(input,deps);assert.equal(e.status,'resting');assert.equal(canceled,0);
  detail={state:'partially_filled',baseVolume:'0.2'};await cycle(input,deps);assert.equal(e.status,'partially-filled');assert.equal(e.protected,true);assert.equal(canceled,0);
  e.cancelRequested=true;await cycle(input,deps);assert.equal(canceled,1);assert.equal(e.status,'canceling');
  detail={state:'canceled',baseVolume:'0.2'};await cycle(input,deps);assert.equal(e.status,'open');assert.equal(closed,0);
  e.action='close';e.cancelRequested=false;detail={state:'partially_filled',baseVolume:'0.1'};await cycle(input,deps);assert.equal(e.status,'resting');assert.equal(closed,0);
  detail={state:'filled',baseVolume:'0.2'};await cycle(input,deps);assert.equal(e.status,'closed');assert.equal(closed,0);
});

test('unprotected GTC partial fill cancels residual before reducing the filled position', async () => {
  const s=state(), e={...manualPreview(body(),context(),s),status:'submitted'};s.journal.entries=[e];
  let detail={state:'partially_filled',baseVolume:'0.2'}, canceled=0, closed=0;
  const client={detail:async()=>detail,cancel:async()=>{canceled++},positions:async()=>[{symbol:'BTCUSDT',holdSide:'long',total:'0.2',posMode:'one_way_mode'}],protection:async()=>[],close:async()=>{closed++}};
  const input={...s,commands:[],paused:true},deps={clientFor:()=>client,save:async()=>{},now:()=>now};
  await cycle(input,deps);assert.equal(e.closeRequested,true);assert.equal(canceled,1);assert.equal(closed,0);
  detail={state:'canceled',baseVolume:'0.2'};await cycle(input,deps);assert.equal(e.status,'closing');assert.equal(closed,1);
});
test('bot controls select side and protective percentages while retaining legacy defaults', () => {
  const c=context(), market={symbol:'BTC/USDT:USDT',status:'connected',candleTime:Math.floor(Date.now()/3600000)*3600000-3600000,price:100,close:100,previousClose:102,lower:101,upper:110,previousLower:101,previousUpper:110,rsi:20};
  const settings={...defaultSettings(),direction:'long',leverage:20,orderType:'market',stopLossPct:1,takeProfitPct:3};
  const p=makeProposal(market,c,settings,state().connections.demo,Date.now());
  assert.equal(p.leverage,20);assert.equal(p.orderType,'market');assert.ok(Math.abs(p.stop-99)<=0.011);assert.ok(Math.abs(p.target-103)<=0.011);
  assert.throws(()=>makeProposal(market,c,{...settings,direction:'short'},state().connections.demo,Date.now()),/direction/);
});

test('manual opens reject unmanaged other-pair exposure and permit freshly verified managed protection only', () => {
  const s=state(), c=context(), b=body();
  c.positions=[{symbol:'SOLUSDT',holdSide:'long',posMode:'one_way_mode',total:'1'}];
  assert.throws(()=>manualPreview(b,c,s),/Unmanaged/);
  c.positions=[];c.orders=[{symbol:'SOLUSDT',orderId:'external',type:'limit'}];
  assert.throws(()=>manualPreview(b,c,s),/Unmanaged/);
  c.positions=[{symbol:'SOLUSDT',holdSide:'long',posMode:'one_way_mode',total:'1'}];
  c.orders=[{symbol:'SOLUSDT',orderId:'sl'},{symbol:'SOLUSDT',orderId:'tp'}];
  const managed={environment:'demo',symbol:'SOLUSDT',side:'long',filled:1,positionQuantity:1,status:'open',protected:true,riskAmount:1,protectionVerifiedAt:Date.now(),protectionOrderIds:['sl','tp']};
  s.journal.entries=[managed];assert.equal(manualPreview(b,c,s).source,'manual');
  managed.riskAmount=20;assert.throws(()=>manualPreview(b,c,s),/risk/);managed.riskAmount=1;
  managed.protectionVerifiedAt-=31000;assert.throws(()=>manualPreview(b,c,s),/Unmanaged/);
  managed.protectionVerifiedAt=Date.now();c.orders.push({symbol:'SOLUSDT',orderId:'external'});assert.throws(()=>manualPreview(b,c,s),/Unmanaged/);
  s.journal.entries=[];c.positions=[{symbol:'BTCUSDT',holdSide:'long',posMode:'one_way_mode',total:'1'}];c.orders=[{symbol:'BTCUSDT',type:'limit',stopLoss:'98',takeProfit:'104'}];
  assert.throws(()=>manualPreview({...b,action:'close'},c,s),/pending exchange/);
});
