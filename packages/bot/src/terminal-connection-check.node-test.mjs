import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerTerminal } from './terminal.ts';

test('saved key checks authenticate, read only, redact errors and reject changed credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connection-check-'));
  const env = { ADMIN_PASSWORD: 'test-admin', TERMINAL_CREDENTIALS_PATH: join(directory,'keys.json'),
    TERMINAL_TRADING_PATH: join(directory,'trading') };
  const old = Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])); Object.assign(process.env,env);
  const originalFetch=globalThis.fetch, calls=[];
  let code='00000', delay, release;
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options}); assert.equal(options.method,'GET'); assert.equal(new URL(url).origin,'https://api.bitget.com');
    if(delay)await delay;
    if(code==='timeout')throw new DOMException('secret-key-network-error','TimeoutError');
    const path=new URL(url).pathname;
    const data=path.endsWith('/account/assets')?{usdtEquity:'0',assets:[]}:
      path.endsWith('/account/accounts')?[{marginCoin:'USDT',usdtEquity:'100',available:'90'}]:
      path.endsWith('/position/current-position')?{list:null}:[];
    return new Response(JSON.stringify({code,msg:'private-key-123456 private-secret private-pass',data}),{status:200});
  };
  const app=Fastify();registerTerminal(app);const headers={authorization:'test-admin'};
  const get=async()=> (await app.inject({url:'/api/terminal/connections',headers})).json();
  const check=async(c)=>app.inject({url:'/api/terminal/connections/'+c.id+'/check',method:'POST',headers,payload:{revision:c.revision}});
  const credentials={apiKey:'private-key-123456',secret:'private-secret',passphrase:'private-pass'};
  try {
    for(const apiVersion of ['v2','v3'])for(const environment of ['live','demo']){
      const added=await app.inject({url:'/api/terminal/connections',method:'POST',headers,payload:{name:apiVersion+' '+environment,apiVersion,environment,permission:'read-only',...credentials,collectionRevision:(await get()).collectionRevision}});
      const c=added.json().connections.at(-1), before=await readFile(env.TERMINAL_CREDENTIALS_PATH,'utf8');
      assert.equal((await app.inject({url:'/api/terminal/connections/'+c.id+'/check',method:'POST',payload:{}})).statusCode,401);
      assert.equal((await app.inject({url:'/api/terminal/connections/'+c.id+'/check',method:'POST',headers:{...headers,origin:'https://evil.example'},payload:{}})).statusCode,403);
      const result=await check(c);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().status,'connected');
      assert.ok(result.json().checkedAt>0);assert.equal(result.json().revision,c.revision);
      assert.equal(calls.at(-1).options.headers.paptrading,environment==='demo'?'1':undefined);
      assert.equal(await readFile(env.TERMINAL_CREDENTIALS_PATH,'utf8'),before,'test must not select or mutate credentials');
    }
    const c=(await get()).connections[0];
    code='40014';const rejected=await check(c);assert.equal(rejected.json().status,'error');assert.match(rejected.json().message,/40014/);
    for(const secret of Object.values(credentials))assert.ok(!rejected.body.includes(secret));
    code='timeout';assert.match((await check(c)).json().message,/reach|timed out/i);
    code='00000';delay=new Promise(resolve=>{release=resolve});
    const pending=check(c);await new Promise(resolve=>setTimeout(resolve,30));
    const duplicate=await check(c);assert.equal(duplicate.statusCode,429);
    const current=await get();await app.inject({url:'/api/terminal/connections/'+c.id,method:'PUT',headers,payload:{name:'updated',permission:'read-only',collectionRevision:current.collectionRevision}});
    release();assert.equal((await pending).statusCode,409,'old result must not label new credentials connected');delay=undefined;
    assert.equal((await check(c)).statusCode,409);
    await mkdir(env.TERMINAL_TRADING_PATH,{recursive:true});
    const execution={demo:{revision:'execution-one',apiVersion:'v3',credentials}};
    await writeFile(join(env.TERMINAL_TRADING_PATH,'connections.json'),JSON.stringify(execution));
    const settings={revision:'settings',environment:'demo',mode:'automatic',armed:true,maxNotional:100,riskPct:2,dailyLossPct:3};
    const journal={version:1,entries:[{id:'open',environment:'demo',status:'open'}],proposals:[],days:{},halted:{},handled:[],accounts:{}};
    await writeFile(join(env.TERMINAL_TRADING_PATH,'settings.json'),JSON.stringify(settings));
    await writeFile(join(env.TERMINAL_TRADING_PATH,'journal.json'),JSON.stringify(journal));
    assert.equal((await app.inject({url:'/api/terminal/trading/connection/check',method:'POST',payload:{environment:'demo'}})).statusCode,401);
    assert.equal((await app.inject({url:'/api/terminal/trading/connection/check',method:'POST',headers:{...headers,origin:'https://evil.example'},payload:{environment:'demo'}})).statusCode,403);
    const result=await app.inject({url:'/api/terminal/trading/connection/check',method:'POST',headers,payload:{environment:'demo',revision:'execution-one'}});
    assert.equal(result.statusCode,200,result.body);assert.equal(result.json().status,'connected');
    assert.deepEqual(JSON.parse(await readFile(join(env.TERMINAL_TRADING_PATH,'connections.json'),'utf8')),execution);
    assert.deepEqual(JSON.parse(await readFile(join(env.TERMINAL_TRADING_PATH,'settings.json'),'utf8')),settings);
    assert.deepEqual(JSON.parse(await readFile(join(env.TERMINAL_TRADING_PATH,'journal.json'),'utf8')),journal);
    assert.equal((await app.inject({url:'/api/terminal/trading/connection/check',method:'POST',headers,payload:{environment:'demo',revision:'old'}})).statusCode,409);
    assert.equal(calls.every(c=>c.options.method==='GET'),true,'no order transport on a connection test');
  } finally {
    await app.close();globalThis.fetch=originalFetch;for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    await rm(directory,{recursive:true,force:true});
  }
});
