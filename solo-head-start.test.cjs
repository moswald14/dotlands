'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Engine=require('./engine.js');

// Exercise the real setup/start/continue UI functions with a deterministic map.
function harness(engine=Engine) {
  const elements=new Map(),storage=new Map();
  const template=fs.readFileSync(path.join(__dirname,'index.template.html'),'utf8');
  const headStartOptions=template.match(/<select id="head-start">([\s\S]*?)<\/select>/)[1];
  const selected=headStartOptions.match(/<option value="([012])" selected>/)[1];
  function el(id) {
    if(!elements.has(id))elements.set(id,{id,hidden:['game','lobby'].includes(id),open:false,
      value:({'country-count':'4','human-count':'2','head-start':selected})[id]||'',dataset:{},attributes:{},
      style:{setProperty(){}},setAttribute(k,v){this.attributes[k]=v;},addEventListener(){},
      showModal(){this.open=true;},close(){this.open=false;},focus(){},select(){},innerHTML:'',textContent:'',isConnected:true});
    return elements.get(id);
  }
  const modes=['solo','local','online'].map(mode=>({dataset:{mode},setAttribute(){}}));
  const context={DotlandsEngine:engine,URL,URLSearchParams,AbortController,console,
    crypto:{getRandomValues(array){array[0]=42;return array;}},location:new URL('https://example.itch.io/game'),
    document:{getElementById:el,querySelectorAll:()=>modes,addEventListener(){},activeElement:null,hidden:false},
    window:{addEventListener(){},scrollTo(){}},navigator:{},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    setTimeout:()=>1,clearTimeout(){}};
  vm.createContext(context);
  const source=fs.readFileSync(path.join(__dirname,'app.js'),'utf8').replace(/\}\)\(\);\s*$/,
    'globalThis.setupTest={startLocal,switchMode,menu,getState:()=>state};})();');
  vm.runInContext(source,context,{filename:'app.js'});
  return {el,client:context.setupTest,storage};
}

test('solo defaults to one extra ready dot on each human starting hex only',()=>{
  const plain=harness();plain.el('head-start').value='0';plain.client.startLocal();
  const assisted=harness();assisted.client.startLocal();
  const baseline=plain.client.getState(),state=assisted.client.getState();
  assert.equal(assisted.el('head-start').value,'1');
  for(const tile of state.tiles){
    const original=baseline.tiles.find(t=>t.id===tile.id);
    assert.equal(tile.owner,original.owner);
    assert.equal(tile.units,original.units+(tile.owner===0?1:0));
    assert.equal(tile.ready,original.ready+(tile.owner===0?1:0));
  }
  assert.equal(Engine.stats(state)[0].units,16);
  assert.equal(Engine.validateState(state).ok,true);
  assert.match(assisted.el('event-log').textContent,/Head start: \+1 dot/);
});

test('solo can select a larger head start or an equal start',()=>{
  for(const [choice,expected] of [['0',13],['2',19],['99',13]]){
    const h=harness();h.el('head-start').value=choice;h.client.startLocal();
    assert.equal(Engine.stats(h.client.getState())[0].units,expected);
    assert.equal(Engine.validateState(h.client.getState()).ok,true);
    for(const stats of Engine.stats(h.client.getState()).slice(1))assert.equal(stats.units,13);
  }
});

test('solo head starts respect the nine-dot cap and keep one garrison',()=>{
  const engine={...Engine,createGame(options){
    const state=Engine.createGame(options);
    for(const tile of state.tiles)if(tile.owner===0){tile.units=8;tile.ready=7;}
    return state;
  }};
  const h=harness(engine);h.el('head-start').value='2';h.client.startLocal();
  for(const tile of h.client.getState().tiles.filter(t=>t.owner===0)){
    assert.equal(tile.units,9);assert.equal(tile.ready,8);
  }
  assert.equal(Engine.validateState(h.client.getState()).ok,true);
});

test('pass-and-play ignores the solo bonus and the selector is solo-only',()=>{
  const h=harness();assert.equal(h.el('head-start-field').hidden,false);
  h.el('head-start').value='2';h.client.switchMode('local');
  assert.equal(h.el('head-start-field').hidden,true);h.client.startLocal();
  assert.deepEqual(Array.from(Engine.stats(h.client.getState()),p=>p.units),[13,13,13,13]);
  h.client.menu();h.client.switchMode('online');assert.equal(h.el('head-start-field').hidden,true);
  h.client.switchMode('solo');assert.equal(h.el('head-start-field').hidden,false);
});

test('continuing a solo save does not grant the head start again',()=>{
  const h=harness();h.el('head-start').value='2';h.client.startLocal();
  const saved=JSON.stringify(h.client.getState());h.client.menu();
  h.el('continue').onclick();
  assert.equal(JSON.stringify(h.client.getState()),saved);
  assert.equal(Engine.stats(h.client.getState())[0].units,19);
});
