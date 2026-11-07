import assert from 'node:assert/strict';
import { test } from 'node:test';
const markets = await import('./terminal-markets.mjs').catch(()=>({}));
const feedModule = await import('./terminal-market-feed.mjs').catch(()=>({}));
const now=1800000000000, HOUR=3600000;
const contract = base => ({symbol:base+'USDT',baseCoin:base,quoteCoin:'USDT',symbolType:'perpetual',symbolStatus:'normal',isRwa:'NO',supportMarginCoins:['USDT'],sizeMultiplier:'0.01',minTradeNum:'0.01',minTradeUSDT:'5'});
const ticker = (base,volume) => ({symbol:base+'USDT',quoteVolume:String(volume),lastPr:'100',bidPr:'99.99',askPr:'100.01',ts:String(now),change24h:'0.01'});
test('a cached open candle cannot become a closed signal when the next response omits its final value', async () => {
  let time = now, omit = false;
  const fetcher = async url => {
    const u = new URL(url), hour = Math.floor(time / HOUR) * HOUR;
    const data = u.pathname.endsWith('/contracts') ? [contract('BTC')] : u.pathname.endsWith('/tickers') ? [{ ...ticker('BTC', 100), ts: String(time) }] :
      Array.from({ length: Number(u.searchParams.get('limit')) }, (_, i) => [hour - i * HOUR,100,101,99,100,10]).filter(r => !omit || r[0] !== hour - HOUR);
    return Response.json({code:'00000',data});
  };
  const feed = feedModule.createMarketFeed({ fetcher, clock: () => time }), pairs = [{ symbol:'BTC/USDT:USDT', watch:true, trade:false }];
  assert.equal((await feed.snapshot(pairs)).markets[0].status, 'connected');
  time += HOUR; omit = true;
  assert.equal((await feed.snapshot(pairs)).markets[0].status, 'unavailable');
  omit = false;
  assert.equal((await feed.snapshot(pairs)).markets[0].status, 'connected');
});
test('catalog ranks quote volume, excludes non-crypto/inactive markets and validates bounded watch/trade settings',()=>{
  assert.equal(typeof markets.buildCatalog,'function');
  const catalog=markets.buildCatalog([contract('BTC'),contract('ETH'),{...contract('STOCK'),isRwa:'YES'},{...contract('OLD'),symbolStatus:'offline'}],
    [ticker('BTC',50),ticker('ETH',500),ticker('STOCK',10000),ticker('OLD',9000)],now);
  assert.deepEqual(catalog.markets.map(m=>m.symbol),['ETH/USDT:USDT','BTC/USDT:USDT']);
  assert.deepEqual(markets.defaultMarkets().pairs.map(p=>p.trade),[true,true]);
  assert.throws(()=>markets.validateMarkets({revision:'x',pairs:[{symbol:'ETH/USDT:USDT',watch:false,trade:true}]}));
  assert.throws(()=>markets.validateMarkets({revision:'x',pairs:Array.from({length:26},(_,i)=>({symbol:'C'+i+'/USDT:USDT',watch:true,trade:false}))}));
  assert.equal(markets.toSymbolId('1000PEPE/USDT:USDT'),'1000PEPEUSDT');
  assert.equal(markets.toSymbolId('BTC/USDC:USDC'),null);
});
test('ten and twenty-five pairs share tickers and do not refetch candles within an hour',async()=>{
  assert.equal(typeof feedModule.createMarketFeed,'function');
  for(const count of [10,25]){
    let time=now,active=0,peak=0;const calls=[];
    const symbols=Array.from({length:count},(_,i)=>'C'+i);
    const fetcher=async(url)=>{
      const u=new URL(url);calls.push(u.pathname);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--;
      let data;
      if(u.pathname.endsWith('/contracts'))data=symbols.map(contract);
      else if(u.pathname.endsWith('/tickers'))data=symbols.map((s,i)=>({...ticker(s,i+1),ts:String(time)}));
      else {const start=Math.floor(time/HOUR)*HOUR; data=Array.from({length:Number(u.searchParams.get('limit'))},(_,i)=>[String(start-i*HOUR),'100','101','99',String(100+Math.sin(i)/10),'10','1000']);}
      return Response.json({code:'00000',data});
    };
    const feed=feedModule.createMarketFeed({fetcher,clock:()=>time});
    const pairs=symbols.map(s=>({symbol:s+'/USDT:USDT',watch:true,trade:false}));
    const first=await feed.snapshot(pairs);assert.equal(first.markets.filter(m=>m.status==='connected').length,count);
    assert.equal(calls.filter(p=>p.endsWith('/candles')).length,count);assert.ok(peak<=2);
    time+=30000;await feed.snapshot(pairs);
    assert.equal(calls.filter(p=>p.endsWith('/candles')).length,count,'warm cycles fetch zero candle histories');
    assert.equal(calls.filter(p=>p.endsWith('/tickers')).length,2,'one bulk ticker call per cycle');
    assert.equal(calls.filter(p=>p.endsWith('/contracts')).length,1);
    time+=HOUR;const next=await feed.snapshot(pairs);assert.equal(next.markets.filter(m=>m.status==='connected').length,count);
    assert.equal(calls.filter(p=>p.endsWith('/candles')).length,2*count);
    const resumed=feedModule.createMarketFeed({fetcher,clock:()=>time,cache:feed.cache()});await resumed.snapshot(pairs);
    assert.equal(calls.filter(p=>p.endsWith('/candles')).length,2*count,'restart reuses valid hourly history');
  }
});
