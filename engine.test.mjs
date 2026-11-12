import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const E=require('./engine.js');

function fixture(count=2) {
  const state={version:E.VERSION,seed:'fixture',radius:3,currentPlayer:0,round:1,turn:1,winner:null,lastEvent:null,players:Array.from({length:count},(_,i)=>({name:E.NAMES[i],color:E.COLORS[i],controller:'human'})),tiles:[]};
  for(let r=-3;r<=3;r++) for(let q=-3;q<=3;q++) if(Math.abs(q+r)<=3)state.tiles.push({id:`${q},${r}`,q,r,owner:-1,units:1,ready:0});
  for(let i=0;i<count;i++) Object.assign(E.getTile(state,[[0,0],[1,0],[-3,0],[3,0]][i].join(',')),{owner:i,units:5,ready:i===0?4:0});
  return state;
}
function put(state,id,owner,units,ready=owner===state.currentPlayer?units-1:0) {
  Object.assign(E.getTile(state,id),{owner,units,ready});
  return E.getTile(state,id);
}
const copy=value=>JSON.parse(JSON.stringify(value));

test('Random continents vary in coastline while preserving connected and equal starting countries',()=>{
  const shapes=new Set();
  for(const radius of [3,4]) for(const count of [2,3,4]) for(let n=0;n<60;n++) {
    const seed=`island-${n}`;
    const options={radius,seed,players:Array.from({length:count},()=>({controller:'human'}))};
    const state=E.createGame(options);
    assert.deepEqual(state,E.createGame(options));
    assert.equal(state.radius,radius+1);
    assert.ok(state.tiles.length>=(radius===3?33:48)&&state.tiles.length<=(radius===3?39:54));
    if(radius===3&&count===2)shapes.add(state.tiles.map(t=>t.id).join(';'));
    assert.equal(E.validateState(state).ok,true);
    for(const stat of E.stats(state)) { assert.equal(stat.tiles,3); assert.equal(stat.units,13); assert.equal(stat.largestCountry,3); assert.equal(stat.countries,1); }
    for(const tile of state.tiles) for(const n of E.neighbors(state,tile)) assert.ok(E.neighbors(state,n).some(t=>t.id===tile.id));
  }
  assert.ok(shapes.size>=55,`Expected many distinct shorelines, got ${shapes.size}`);
  assert.notDeepEqual(E.createGame({seed:'a'}).tiles,E.createGame({seed:'b'}).tiles);
});

test('Winning attacks use subtraction and leave the capturing dots exhausted',()=>{
  const state=fixture();
  put(state,'0,0',0,7); put(state,'1,0',1,3); put(state,'3,0',1,2);
  const preview=E.previewMove(state,'0,0','1,0',6), before=copy(state);
  assert.equal(preview.type,'capture'); assert.equal(preview.targetUnits,3); assert.equal(preview.losses,3);
  assert.deepEqual(state,before,'Preview must be read-only');
  assert.equal(E.applyMove(state,'0,0','1,0',6).ok,true);
  assert.deepEqual(E.getTile(state,'0,0'),{id:'0,0',q:0,r:0,owner:0,units:1,ready:0});
  assert.equal(E.getTile(state,'1,0').units,3); assert.equal(E.getTile(state,'1,0').owner,0); assert.equal(E.getTile(state,'1,0').ready,0);
  assert.equal(E.maxSend(state,'1,0'),0);
});

test('Losing attacks reduce defenders without capturing or moving the garrison',()=>{
  const state=fixture(); put(state,'1,0',1,7);
  const event=E.applyMove(state,'0,0','1,0');
  assert.equal(event.type,'attack'); assert.equal(event.amount,4); assert.equal(event.losses,4);
  assert.equal(E.getTile(state,'1,0').owner,1); assert.equal(E.getTile(state,'1,0').units,3);
  assert.equal(E.getTile(state,'0,0').units,1);
});

test('Equal armies clear a neutral tile which can then be occupied',()=>{
  const state=fixture(); put(state,'0,0',0,4); put(state,'1,0',1,3); put(state,'3,0',1,2); put(state,'1,-1',0,2);
  const event=E.applyMove(state,'0,0','1,0',3);
  assert.equal(event.type,'clear'); assert.equal(E.getTile(state,'1,0').owner,-1); assert.equal(E.getTile(state,'1,0').units,0);
  assert.equal(E.applyMove(state,'1,-1','1,0',1).type,'capture');
  assert.equal(E.getTile(state,'1,0').owner,0); assert.equal(E.getTile(state,'1,0').units,1);
  assert.equal(E.validateState(state).ok,true);
});

test('Illegal actions are rejected without mutation, including remote, fractional, opponent and empty moves',()=>{
  const state=fixture();
  for(const [from,to,amount] of [['0,0','1,0',5],['0,0','1,0',3],['0,0','1,0',0],['0,0','1,0',-1],['0,0','1,0',1.5],['0,0','1,0',NaN],['0,0','1,0','2'],['0,0','3,0',1],['1,0','0,0',1],['missing','0,0',1],['0,0','0,0',1]]) {
    const before=copy(state); assert.equal(E.applyMove(state,from,to,amount).ok,false); assert.deepEqual(state,before);
  }
  put(state,'0,0',0,1); assert.equal(E.maxSend(state,'0,0'),0);
});

test('Friendly transfers respect capacity and never let incoming dots move twice',()=>{
  const state=fixture(); put(state,'0,0',0,9); put(state,'0,1',0,7,2);
  assert.equal(E.maxSend(state,'0,0','0,1'),2);
  assert.equal(E.applyMove(state,'0,0','0,1',3).ok,false);
  assert.equal(E.applyMove(state,'0,0','0,1',2).type,'transfer');
  assert.equal(E.getTile(state,'0,1').units,9); assert.equal(E.getTile(state,'0,1').ready,2);
  assert.equal(E.applyMove(state,'0,1','-1,1',3).ok,false);
  assert.equal(E.applyMove(state,'0,1','-1,1',2).ok,true);
  assert.equal(E.getTile(state,'0,1').ready,0);
});

test('Ending a turn grows only the outgoing country, caps at nine, and refreshes the next player',()=>{
  const state=fixture(); put(state,'0,0',0,9); put(state,'0,1',0,1);
  const neutral=E.getTile(state,'-1,0').units;
  const result=E.endTurn(state);
  assert.equal(result.growth,1); assert.equal(state.currentPlayer,1); assert.equal(state.turn,2); assert.equal(state.round,1);
  assert.equal(E.getTile(state,'0,0').units,9); assert.equal(E.getTile(state,'0,0').ready,0);
  assert.equal(E.getTile(state,'0,1').units,2); assert.equal(E.getTile(state,'1,0').ready,4);
  assert.equal(E.getTile(state,'-1,0').units,neutral);
  E.endTurn(state); assert.equal(state.round,2); assert.equal(state.currentPlayer,0); assert.equal(E.getTile(state,'0,1').ready,1);
});

test('Eliminated seats are skipped, including at the round boundary',()=>{
  const state=fixture(4); put(state,'1,0',-1,2); put(state,'3,0',-1,2);
  E.endTurn(state); assert.equal(state.currentPlayer,2); assert.equal(state.round,1);
  E.endTurn(state); assert.equal(state.currentPlayer,0); assert.equal(state.round,2);
  assert.equal(E.validateState(state).ok,true);
});

test('Capturing the last opposing hex wins immediately and locks the match',()=>{
  const state=fixture(); put(state,'1,0',1,2);
  const result=E.applyMove(state,'0,0','1,0',4);
  assert.equal(result.winner,0); assert.equal(state.winner,0);
  const before=copy(state);
  assert.equal(E.applyMove(state,'0,0','-1,0',1).ok,false); assert.equal(E.endTurn(state).ok,false); assert.deepEqual(state,before);
  assert.equal(E.validateState(state).ok,true);
});

test('Countries may span multiple hexes or split; every owned hex still needs a dot',()=>{
  const state=fixture(); put(state,'-1,0',0,2); put(state,'-3,0',0,1);
  const stat=E.stats(state)[0]; assert.equal(stat.tiles,3); assert.equal(stat.countries,2); assert.equal(stat.largestCountry,2);
  put(state,'-3,0',0,0,0); assert.equal(E.validateState(state).ok,false);
});

test('Save validation rejects malformed ownership, readiness, geometry and victory',()=>{
  const state=fixture();
  const corruptions=[s=>{s.tiles[0].units=10;},s=>{s.tiles[0].ready=1;},s=>{s.tiles[0].owner=12;},s=>{s.tiles[0].id=s.tiles[1].id;},s=>{s.currentPlayer=7;},s=>{s.winner=0;},s=>{s.players[0].color='red';},s=>{s.tiles.push(s.tiles[0]);},s=>{s.round=0;},s=>{s.players[0]=null;}];
  for(const corrupt of corruptions) {const broken=copy(state);corrupt(broken);assert.equal(E.validateState(broken).ok,false);}
  assert.equal(E.validateState(null).ok,false);
  assert.equal(E.validateState(copy(state)).ok,true);
  const legacy=copy(state);legacy.version=1;assert.equal(E.validateState(legacy).ok,true,'Existing games remain playable with the simpler move rule');
  const split=copy(state);split.tiles=split.tiles.filter(t=>t.q!==0);assert.equal(E.validateState(split).ok,false,'Unreachable islands cannot be loaded');
});

test('AI can coordinate attacks to break a nine-dot defended tile',()=>{
  const state=fixture();
  for(const t of state.tiles) Object.assign(t,{owner:0,units:1,ready:0});
  put(state,'1,0',1,9); put(state,'0,0',0,7); put(state,'1,-1',0,6);
  const first=E.chooseAIMove(state); assert.ok(first); assert.equal(first.to,'1,0'); assert.equal(E.applyMove(state,first.from,first.to,first.amount).ok,true);
  const second=E.chooseAIMove(state); assert.ok(second); assert.equal(second.to,'1,0'); assert.equal(E.applyMove(state,second.from,second.to,second.amount).ok,true);
  assert.equal(state.winner,0);
});

test('AI simulations preserve population, legal turns, and move exhaustion across many seeded matches',()=>{
  let wins=0, turns=0, moves=0;
  for(let seed=0;seed<12;seed++) {
    const state=E.createGame({seed:`simulation-${seed}`,radius:seed%2?3:4,players:Array.from({length:2+seed%3},()=>({controller:'ai'}))});
    for(let t=0;t<220 && state.winner===null;t++) {
      let move, count=0;
      while((move=E.chooseAIMove(state))&&count++<100) {
        const readyBefore=E.stats(state)[state.currentPlayer].ready;
        assert.equal(move.amount,E.maxSend(state,move.from,move.to),'Computers must use the same maximum move as humans');
        assert.equal(E.applyMove(state,move.from,move.to,move.amount).ok,true,JSON.stringify(move));
        assert.equal(E.validateState(state).ok,true,JSON.stringify(E.validateState(state)));
        assert.ok(E.stats(state)[state.currentPlayer].ready<readyBefore);
        moves++;
      }
      assert.ok(count<100,'AI should not loop');
      if(state.winner===null) E.endTurn(state);
      turns++;
      assert.equal(E.validateState(state).ok,true);
    }
    if(state.winner!==null) wins++;
  }
  assert.ok(wins>=8,`Expected most matches to finish; finished ${wins}/12`);
  console.log(`Simulation evidence: ${wins}/12 completed games, ${turns} turns, ${moves} legal moves.`);
});
