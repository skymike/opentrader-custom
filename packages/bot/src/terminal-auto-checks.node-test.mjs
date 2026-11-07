import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnectionsPanel } from '../../../app/frontend/terminal/connections.js';

// Minimal DOM adapter; the real page is also exercised by the browser regression.
class Element {
  constructor() { this.children=[]; this.classList={toggle(){}}; this.elements={permission:{value:'read-only'}}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=children; }
  addEventListener() {}
  setAttribute() {}
  reset() {}
}
const until = async predicate => {
  for (let i=0;i<100;i++) { if(predicate())return; await new Promise(r=>setTimeout(r,5)); }
  assert.fail('Timed out waiting for automatic check');
};
test('automatic checks are sequential, ignore stale metadata, remember revisions and reset on sign-out', async () => {
  const originalDocument=globalThis.document, originalFetch=globalThis.fetch;
  const nodes=new Map();globalThis.document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)},createElement(){return new Element()}};
  const calls=[], pending=[];
  let auth, releaseMetadata;
  const monitor={connections:[]};
  globalThis.fetch=async(url,options)=>{
    if(url==='/api/terminal/connections')return Response.json(monitor);
    if(url==='/api/terminal/trading')return new Promise(resolve=>{releaseMetadata=()=>resolve(Response.json({connections:{demo:{configured:true,revision:'old',apiVersion:'v2'}}}))});
    const body=JSON.parse(options.body);calls.push(body);
    return new Promise(resolve=>pending.push(()=>resolve(Response.json({status:'connected',checkedAt:Date.now(),revision:body.revision}))));
  };
  try {
    const panel=createConnectionsPanel(()=>auth,()=>{},()=>{});
    panel.start();assert.equal(calls.length,0);
    auth='test-session';panel.start();await until(()=>releaseMetadata);
    panel.updateExecution({demo:{configured:true,revision:'new',apiVersion:'v3'}});
    await until(()=>calls.length===1);assert.equal(calls[0].revision,'new');
    releaseMetadata();await new Promise(r=>setTimeout(r,20));pending.shift()();
    await until(()=>nodes.get('key-health').textContent.includes('1 / 1 connected'));
    panel.updateExecution({demo:{configured:true,revision:'new',apiVersion:'v3'}});
    await new Promise(r=>setTimeout(r,20));assert.deepEqual(calls.map(c=>c.revision),['new'],'delayed metadata must not trigger old/new duplicate checks');
    panel.update({connections:[{id:'a',revision:'a1',name:'A',apiVersion:'v2',environment:'live'}, {id:'b',revision:'b1',name:'B',apiVersion:'v3',environment:'demo'}]});
    await until(()=>calls.length===2);assert.equal(pending.length,1,'only one automatic check at a time');
    panel.update({connections:[{id:'a',revision:'a2',name:'A',apiVersion:'v2',environment:'live'}]});
    pending.shift()();await until(()=>calls.length===3);assert.equal(calls[2].revision,'a2');
    auth=undefined;panel.clear();pending.shift()();await new Promise(r=>setTimeout(r,20));
    assert.match(nodes.get('key-health').textContent,/Sign in/);assert.equal(calls.length,3,'queued keys are not checked after sign-out');
    auth='test-session';panel.update({connections:[]});panel.updateExecution({demo:{configured:true,revision:'new',apiVersion:'v3'}});
    await until(()=>calls.length===4);pending.shift()();await until(()=>nodes.get('key-health').textContent.includes('1 / 1 connected'));
  } finally { globalThis.document=originalDocument;globalThis.fetch=originalFetch; }
});
