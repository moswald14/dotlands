/* Behavior tests for asynchronous UI ownership. This is a small DOM stub, not
 * browser/layout verification. It executes the real app functions in a VM. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const E=require('./engine.js');
function harness() {
  const elements=new Map(),timers=new Map(),storage=new Map(),requests=[],copied=[],sessions=[];let timerId=0,pending=[];
  function el(id) {
    if(!elements.has(id))elements.set(id,{id,hidden:['game','lobby'].includes(id),open:false,value:id==='country-count'?'4':id==='human-count'?'2':'',dataset:{},attributes:{},style:{setProperty(){}},setAttribute(name,value){this.attributes[name]=value;},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},focus(){},select(){},innerHTML:'',textContent:'',isConnected:true});
    return elements.get(id);
  }
  const modes=['solo','local','online'].map(mode=>({dataset:{mode},setAttribute(){}}));
  const context={
    DotlandsEngine:E,URL,URLSearchParams,AbortController,console,
    location:new URL('https://example.itch.io/game'),
    document:{getElementById:el,querySelectorAll:()=>modes,addEventListener(){},activeElement:null,hidden:false},
    window:{addEventListener(){}},navigator:{clipboard:{writeText:async text=>{copied.push(text);}}},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    fetch:(...args)=>{requests.push(args);return new Promise(resolve=>pending.push({args,resolve}));}
  };
  async function sessionStub(config,join=false,resume=false) {
    const response=await context.fetch(config.url+'/api/rooms'+(join||resume?'/'+(config.room||config.code)+(resume?'':'/join'):''),{method:resume?'GET':'POST'});
    const data=await response.json();
    const session={initial:data,credentials:{url:config.url,code:data.code,seat:data.seat,token:data.token,role:join||resume?'guest':'host'},closed:false,config,
      async request(route,body){const response=await context.fetch(config.url+'/api'+route,{method:body===undefined?'GET':'POST'});return response.json();},close(){this.closed=true;}};
    sessions.push(session);return session;
  }
  context.DotlandsRoom={create:c=>sessionStub(c),join:c=>sessionStub(c,true),reconnect:c=>sessionStub(c,false,true)};
  vm.createContext(context);
  const source=fs.readFileSync(path.join(__dirname,'app.js'),'utf8').replace(/\}\)\(\);\s*$/,`globalThis.clientTest={menu,pollRoom,startRoom,reconnect,enterRoom,startLocal,runAI,remoteAction,acceptSnapshot,pickTile,commit,render,copyInvite,myTurn,setSession(s){online=s.online;room=s.room;state=s.state;},getSession(){return {online,room,state,busy,aiRunning};}};})();`);
  vm.runInContext(source,context,{filename:'app.js'});
  const connection={url:'https://server.example',code:'ABC234',seat:0,token:'test-token'};
  const lobby={code:'ABC234',revision:1,phase:'lobby',maxPlayers:4,hostSeat:0,seat:0,players:[{seat:0,name:'Moss'}]};
  context.clientTest.setSession({online:connection,room:lobby,state:null});
  context.clientTest.acceptSnapshot(lobby);
  const respond=(data,status=200)=>{assert.ok(pending.length,'Expected a pending request');pending.shift().resolve({ok:status<400,status,json:async()=>data});};
  const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  const wake=async()=>{respond({ok:true,game:'Dotlands',protocol:1,doodletick:1});await flush();};
  const fireTimer=async(ms)=>{
    const entry=[...timers].find(([,timer])=>timer.ms===ms);assert.ok(entry,`Expected a ${ms} ms timer`);
    timers.delete(entry[0]);entry[1].fn();await flush();
  };
  return {client:context.clientTest,el,respond,connection,lobby,storage,timers,fireTimer,flush,wake,requests,copied,sessions};
}
test('Leaving an online room keeps the menu open when an earlier poll finishes',async()=>{
  const h=harness();const request=h.client.pollRoom();
  h.client.menu();
  h.respond({...h.lobby,revision:2});await request;
  assert.equal(h.el('welcome').hidden,false,'An old poll must not reopen the lobby');
  assert.equal(h.el('lobby').hidden,true);
  assert.equal(h.timers.size,0,'Leaving must not restart polling');
});
test('Leaving during Start game ignores the eventual server response',async()=>{
  const h=harness();const request=h.client.startRoom();h.client.menu();
  h.respond({...h.lobby,revision:2,phase:'playing',state:E.createGame()});await request;
  assert.equal(h.el('welcome').hidden,false,'A stale Start response must not reopen the game');
  assert.equal(h.el('game').hidden,true);
});
test('Starting a local game ignores a late online poll',async()=>{
  const h=harness();const request=h.client.pollRoom();h.client.startLocal();
  const local=h.client.getSession().state;
  h.respond({...h.lobby,revision:2,phase:'playing',state:E.createGame({seed:'remote'})});await request;
  assert.equal(h.client.getSession().state,local);
  assert.equal(h.client.getSession().online,null);
});
test('Menu during reconnect ignores the saved room response',async()=>{
  const h=harness();h.storage.set('doodletick.dotlands.room.v1',JSON.stringify(h.connection));h.client.menu();
  const request=h.client.reconnect();await h.wake();h.client.menu();
  h.respond({...h.lobby,revision:3,phase:'playing',state:E.createGame({seed:'reconnected'})});await request;
  assert.equal(h.el('welcome').hidden,false);assert.equal(h.el('game').hidden,true);
  assert.equal(h.client.getSession().online,null);assert.equal(h.client.getSession().state,null);
  assert.equal(h.timers.size,0);
});
test('Leaving while creating a room ignores the late room response',async()=>{
  const h=harness();h.client.menu();h.el('server-url').value=h.connection.url;
  const request=h.client.enterRoom(false);await h.wake();h.client.menu();
  h.respond({...h.lobby,token:'new-token'});await request;
  assert.equal(h.el('welcome').hidden,false);assert.equal(h.el('lobby').hidden,true);
  assert.equal(h.client.getSession().online,null);assert.equal(h.storage.has('doodletick.dotlands.room.v1'),false);
  assert.equal(h.sessions[0].closed,true,'Late peer connection must be closed');
  assert.equal(h.timers.size,0);
});
test('A late online Start response cannot overwrite a new local match',async()=>{
  const h=harness();const request=h.client.startRoom();h.client.startLocal();
  const local=h.client.getSession().state;
  h.respond({...h.lobby,revision:2,phase:'playing',state:E.createGame({seed:'old-remote'})});await request;
  assert.equal(h.client.getSession().state,local);assert.equal(h.client.getSession().online,null);
  assert.equal(h.el('game').hidden,false);assert.equal(h.timers.size,0);
});
test('An obsolete request cannot clear the busy state of a newer request',async()=>{
  const h=harness();const oldRequest=h.client.startRoom();h.client.menu();h.el('server-url').value=h.connection.url;
  const newRequest=h.client.enterRoom(false);
  h.respond({...h.lobby,revision:2,phase:'playing',state:E.createGame()});await oldRequest;
  assert.equal(h.client.getSession().busy,true);assert.equal(h.el('create-room').disabled,true);
  await h.wake();
  h.respond({...h.lobby,code:'NEW234',token:'new-token'});await newRequest;
  assert.equal(h.client.getSession().busy,false);assert.equal(h.client.getSession().online.code,'NEW234');
});
test('Menu safely cancels an AI waiting before its first move even though state becomes null',async()=>{
  const h=harness();const state=E.createGame({players:[{controller:'ai'},{controller:'human'}]});
  h.client.setSession({online:null,room:null,state});const request=h.client.runAI();h.client.menu();
  await h.fireTimer(350);await request;
  assert.equal(h.client.getSession().state,null);assert.equal(h.client.getSession().aiRunning,false);
  assert.equal(h.el('welcome').hidden,false);assert.equal(h.timers.size,0);
});
test('Menu safely cancels an AI waiting between moves and preserves the saved position',async()=>{
  const h=harness();const state=E.createGame({players:[{controller:'ai'},{controller:'human'}]});
  h.client.setSession({online:null,room:null,state});const request=h.client.runAI();await h.fireTimer(350);
  assert.ok(state.lastEvent,'AI should have made one move');h.client.menu();
  const saved=h.storage.get('dotlands.local.v1');await h.fireTimer(190);await request;
  assert.equal(h.client.getSession().state,null);assert.equal(h.storage.get('dotlands.local.v1'),saved);
  assert.equal(h.el('welcome').hidden,false);assert.equal(h.timers.size,0);
});

test('Default solo mode creates one human country',()=>{
  const h=harness();h.client.startLocal();
  assert.equal(h.client.getSession().state.players.filter(p=>p.controller==='human').length,1);
  assert.equal(h.el('modal').open,false);
});

test('Battle preview and confirmation send all available dots with no amount controls',async()=>{
  const h=harness(),state=E.createGame({seed:'maximum',players:[{controller:'human'},{controller:'ai'}]});
  const from=state.tiles.find(t=>t.owner===0&&E.neighbors(state,t).some(n=>n.owner!==0));
  const to=E.neighbors(state,from).find(t=>t.owner!==0);
  Object.assign(from,{units:9,ready:8});Object.assign(to,{units:2});
  h.client.setSession({online:null,room:null,state});h.client.pickTile(from.id);h.client.pickTile(to.id);
  assert.match(h.el('controls').innerHTML,/Attack with 8 dots/);
  assert.doesNotMatch(h.el('controls').innerHTML,/amount-control|id="less"|id="more"/);
  await h.client.commit();assert.equal(from.units,1);assert.equal(from.ready,0);assert.equal(to.units,6);assert.equal(to.owner,0);
});

test('Friendly maximum moves stop at the nine-dot capacity',async()=>{
  const h=harness(),state=E.createGame({seed:'transfer',players:[{controller:'human'},{controller:'ai'}]});
  const from=state.tiles.find(t=>t.owner===0&&E.neighbors(state,t).some(n=>n.owner===0));
  const to=E.neighbors(state,from).find(t=>t.owner===0);
  Object.assign(from,{units:9,ready:8});Object.assign(to,{units:8,ready:1});
  h.client.setSession({online:null,room:null,state});h.client.pickTile(from.id);h.client.pickTile(to.id);
  assert.match(h.el('controls').innerHTML,/Move 1 dot/);
  await h.client.commit();assert.equal(from.units,8);assert.equal(to.units,9);assert.equal(to.ready,1);
});

test('Every irregular continent fits within the SVG viewport',()=>{
  const h=harness();
  for(let seed=0;seed<30;seed++){
    const state=E.createGame({seed:`bounds-${seed}`});h.client.setSession({online:null,room:null,state});h.client.render();
    const [left,top,width,height]=h.el('board').attributes.viewBox.split(' ').map(Number);
    for(const tile of state.tiles){
      const x=Math.sqrt(3)*(tile.q+tile.r/2)*32,y=tile.r*48;
      assert.ok(x-30>=left&&x+30<=left+width&&y-30>=top&&y+30<=top+height);
    }
  }
});

test('A sleeping server is awakened with safe health reads before creating exactly one room',async()=>{
  const h=harness();h.client.menu();h.el('server-url').value=h.connection.url;
  const request=h.client.enterRoom(false);h.respond({},503);await h.flush();
  assert.match(h.el('online-status').textContent,/Waking/);await h.fireTimer(2500);await h.wake();
  h.respond({...h.lobby,token:'new-token'});await request;
  assert.deepEqual(h.requests.map(([,options])=>options.method),['GET','GET','POST']);
  assert.equal(h.client.getSession().online.code,h.lobby.code);
});

test('Leaving while the server wakes cancels joining without sending a room request',async()=>{
  const h=harness();h.client.menu();h.el('server-url').value=h.connection.url;
  const request=h.client.enterRoom(false);h.respond({},503);await h.flush();h.client.menu();await h.fireTimer(2500);await request;
  assert.equal(h.requests.length,1);assert.equal(h.client.getSession().online,null);assert.equal(h.el('welcome').hidden,false);
});

test('An unknown server fails without repeated requests',async()=>{
  const h=harness();h.client.menu();h.el('server-url').value=h.connection.url;
  const request=h.client.enterRoom(false);h.respond({ok:true,game:'Different game',protocol:1});await request;
  assert.equal(h.requests.length,1);assert.match(h.el('online-status').textContent,/not a Dotlands/);assert.equal(h.client.getSession().busy,false);
});

test('Room invitations open the standalone hosted game and never share a seat token',async()=>{
  const h=harness();await h.client.copyInvite();
  assert.match(h.copied[0],/https:\/\/server\.example\/\?room=ABC234/);
  assert.doesNotMatch(h.copied[0],/itch\.io|test-token|token=/);
});

test('An invalid peer snapshot cannot replace a valid board or room',()=>{
  const h=harness(),state=E.createGame({seed:'safe-board'});
  h.client.setSession({online:h.connection,room:h.lobby,state});
  assert.throws(()=>h.client.acceptSnapshot({...h.lobby,revision:2,phase:'playing',state:{tiles:[]}}));
  assert.equal(h.client.getSession().state,state);
  assert.equal(h.client.getSession().room,h.lobby);
});

test('Leaving a live peer room closes it and ignores subsequent callbacks',async()=>{
  const h=harness();h.client.menu();h.el('server-url').value=h.connection.url;
  const request=h.client.enterRoom(false);await h.wake();h.respond({...h.lobby,token:'new-token'});await request;
  const session=h.sessions[0];h.client.menu();
  assert.equal(session.closed,true);
  session.config.onSnapshot({...h.lobby,revision:2,phase:'playing',state:E.createGame()});
  session.config.onStatus({state:'connected',transport:'direct'});
  assert.equal(h.client.getSession().state,null);
  assert.equal(h.el('welcome').hidden,false);
  assert.equal(h.el('connection-status').hidden,true);
});

test('A lost peer connection freezes actions and recovery unlocks them',async()=>{
  const h=harness();h.client.menu();h.el('server-url').value=h.connection.url;
  const request=h.client.enterRoom(false);await h.wake();h.respond({...h.lobby,token:'new-token'});await request;
  const session=h.sessions[0];session.config.onSnapshot({...h.lobby,revision:2,phase:'playing',state:E.createGame()});
  session.config.onStatus({state:'disconnected',reason:'Host disconnected'});
  assert.equal(h.client.myTurn(),false);
  session.config.onStatus({state:'connected',transport:'relay'});
  assert.equal(h.client.myTurn(),true);
  assert.match(h.el('connection-status').textContent,/Connection assist/);
});
