import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerTerminal } from './terminal.ts';
test('market presets and manual additions stay watch-only; changing trade list disarms and rejects stale edits',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'market-api-'));
  const env={ADMIN_PASSWORD:'test-admin',TERMINAL_TRADING_PATH:dir,TERMINAL_CATALOG_PATH:join(dir,'catalog.json')};
  const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  const app=Fastify();registerTerminal(app);const headers={authorization:'test-admin'},url='/api/terminal/markets';
  const catalog={updatedAt:Date.now(),markets:['BTC','SOL',...Array.from({length:28},(_,i)=>'C'+i)].map((base,i)=>({symbol:base+'/USDT:USDT',id:base+'USDT',volume:1000000-i,price:100}))};
  const settings={revision:'existing',environment:'demo',mode:'automatic',armed:true,maxNotional:100,riskPct:2,dailyLossPct:3};
  await writeFile(env.TERMINAL_CATALOG_PATH,JSON.stringify(catalog));await writeFile(join(dir,'settings.json'),JSON.stringify(settings));
  const get=async()=>(await app.inject({url,headers})).json();
  try{
    assert.equal((await app.inject({url})).statusCode,401);
    assert.equal((await app.inject({url,headers:{...headers,origin:'https://evil.example'},method:'PUT',payload:{}})).statusCode,403);
    const initial=await get();assert.deepEqual(initial.pairs.filter(p=>p.trade).map(p=>p.symbol),['BTC/USDT:USDT','SOL/USDT:USDT']);
    const preset=await app.inject({url,headers,method:'PUT',payload:{revision:initial.revision,action:'top10'}});
    assert.equal(preset.statusCode,200,preset.body);assert.equal(preset.json().pairs.length,10);
    assert.deepEqual(preset.json().pairs.filter(p=>p.trade).map(p=>p.symbol),['BTC/USDT:USDT','SOL/USDT:USDT']);
    assert.equal(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).armed,true,'watch additions preserve existing armed preference');
    const current=await get();const pairs=[...current.pairs,{symbol:'C20/USDT:USDT',watch:true,trade:false}];
    assert.equal((await app.inject({url,headers,method:'PUT',payload:{revision:current.revision,pairs}})).statusCode,200);
    assert.equal((await app.inject({url,headers,method:'PUT',payload:{revision:initial.revision,pairs}})).statusCode,409);
    const next=await get();next.pairs.at(-1).trade=true;
    const enabled=await app.inject({url,headers,method:'PUT',payload:{revision:next.revision,pairs:next.pairs}});
    assert.equal(enabled.statusCode,200,enabled.body);assert.equal(enabled.json().trading.armed,false);
    assert.notEqual(JSON.parse(await readFile(join(dir,'settings.json'),'utf8')).revision,'existing');
    const bad=await get();bad.pairs.push({symbol:'FAKE/USDT:USDT',watch:true,trade:true});
    assert.equal((await app.inject({url,headers,method:'PUT',payload:{revision:bad.revision,pairs:bad.pairs}})).statusCode,400);
    await writeFile(env.TERMINAL_CATALOG_PATH,JSON.stringify({...catalog,updatedAt:1}));
    const off=await get();off.pairs=off.pairs.map(p=>({...p,trade:false,watch:false}));
    assert.equal((await app.inject({url,headers,method:'PUT',payload:{revision:off.revision,pairs:off.pairs}})).statusCode,200,'turning pairs off works even when catalog is stale');
    const latest=await get();assert.equal((await app.inject({url,headers,method:'PUT',payload:{revision:latest.revision,action:'top10'}})).statusCode,503);
  }finally{await app.close();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(dir,{recursive:true,force:true});}
});
