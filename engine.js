/* DOTLANDS — deterministic rules shared by the browser and optional room server.
 * No DOM, network, clock, or dependencies. All game mutations go through applyMove/endTurn.
 * createGame({seed, radius:3|4, players:[{name,color,controller:'human'|'ai'}]})
 * neighbors(state,id) returns tile objects. connectedCountries returns {owner,tiles:[id],size,units}[];
 * stats returns one {player,tiles,units,largestCountry,countries,ready} record per player.
 * previewMove/applyMove return {ok,error?} plus an event when legal. applyMove mutates state.
 * endTurn mutates state, grows the outgoing player's tiles, and prepares the next player.
 * validateState returns {ok,errors:[]}; chooseAIMove returns {from,to,amount} or null.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DotlandsEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 2;
  const DIRECTIONS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const COLORS = ['#4d947d', '#d77c68', '#c49b45', '#9581ba'];
  const NAMES = ['Moss', 'Ember', 'Honey', 'Iris'];
  const indices = new WeakMap();
  const key = (q, r) => `${q},${r}`;
  const distance = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
  function hash(value) {
    let h = 2166136261;
    for (const char of String(value)) { h ^= char.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function randomFor(seed) {
    let x = hash(seed) || 1;
    return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
  }
  function index(state) {
    let lookup=indices.get(state.tiles);
    if(!lookup) { lookup=new Map(state.tiles.map(tile=>[tile.id,tile])); indices.set(state.tiles,lookup); }
    return lookup;
  }
  function getTile(state, id) { return index(state).get(id) || null; }
  function neighbors(state, id) {
    const tile = typeof id === 'object' ? id : getTile(state, id);
    if (!tile) return [];
    const map = index(state);
    return DIRECTIONS.map(([q, r]) => map.get(key(tile.q + q, tile.r + r))).filter(Boolean);
  }
  function createGame(options = {}) {
    const size = options.radius === 4 ? 4 : 3;
    const radius = size + 1;
    const supplied = options.players || [{controller:'human'}, {controller:'ai'}, {controller:'ai'}, {controller:'ai'}];
    if (!Array.isArray(supplied) || supplied.length < 2 || supplied.length > 4) throw new Error('Choose two to four countries.');
    const players = supplied.map((p, i) => ({
      name: String(p.name || NAMES[i]).trim().slice(0, 24) || NAMES[i],
      color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : COLORS[i],
      controller: p.controller === 'ai' ? 'ai' : 'human'
    }));
    const seed = String(options.seed ?? 'dotlands').slice(0, 128);
    const random = randomFor(seed);
    // A connected heart grows into a different coastline for every seed. Growth
    // always touches existing land, so there are no unreachable islands.
    const land = new Map();
    const core = size-1, wanted = size===3 ? 33+Math.floor(random()*7) : 48+Math.floor(random()*7);
    for(let r=-core;r<=core;r++) for(let q=-core;q<=core;q++) {
      if(Math.abs(q+r)<=core) land.set(key(q,r),{q,r});
    }
    const stretch = random()*Math.PI*2;
    while(land.size<wanted) {
      const edge=new Map();
      for(const tile of land.values()) for(const [dq,dr] of DIRECTIONS) {
        const q=tile.q+dq,r=tile.r+dr,id=key(q,r);
        if(!land.has(id)&&Math.max(Math.abs(q),Math.abs(r),Math.abs(q+r))<=radius) edge.set(id,{q,r});
      }
      const choices=[...edge.values()].map(tile=>{
        const touching=DIRECTIONS.filter(([q,r])=>land.has(key(tile.q+q,tile.r+r))).length;
        const angle=Math.atan2(tile.r*1.5,Math.sqrt(3)*(tile.q+tile.r/2));
        return {tile,weight:Math.pow(touching,1.25)*(1+.35*Math.cos(2*(angle-stretch)))};
      });
      let pick=random()*choices.reduce((sum,c)=>sum+c.weight,0), chosen=choices[choices.length-1].tile;
      for(const choice of choices) {pick-=choice.weight;if(pick<=0){chosen=choice.tile;break;}}
      land.set(key(chosen.q,chosen.r),chosen);
    }
    const tiles=[...land.values()].sort((a,b)=>a.r-b.r||a.q-b.q).map(({q,r})=>({id:key(q,r),q,r,owner:-1,units:1+Math.floor(random()*3),ready:0}));
    const state = {version:VERSION, seed, radius, players, tiles, currentPlayer:0, round:1, turn:1, winner:null, lastEvent:null};
    const coast=tiles.filter(t=>{const n=neighbors(state,t).length;return n>=2&&n<6;});
    const starts=[coast[Math.floor(random()*coast.length)]];
    while(starts.length<players.length) {
      const candidates=coast.filter(t=>!starts.includes(t)).map(tile=>({tile,score:Math.min(...starts.map(start=>distance(tile,start)))*10+distance(tile,{q:0,r:0})*.1+random()*.1}));
      candidates.sort((a,b)=>b.score-a.score);starts.push(candidates[0].tile);
    }
    const reserved = new Set(starts.map(t=>t.id));
    starts.forEach((start, owner) => {
      const initial = [start];
      // Equal connected starts, with neighbors of other capitals reserved.
      for (let n = 1; n < 3; n++) {
        const candidates = [...new Map(initial.flatMap(t => neighbors(state,t)).map(t=>[t.id,t])).values()]
          .filter(t => t.owner < 0 && !reserved.has(t.id) && !initial.includes(t))
          .sort((a,b) => {
            const safety=t=>Math.min(...starts.filter(s=>s!==start).map(s=>distance(t,s)));
            return (safety(a)<2)-(safety(b)<2)||distance(a,start)-distance(b,start)||distance(a,{q:0,r:0})-distance(b,{q:0,r:0})||a.id.localeCompare(b.id);
          });
        if (!candidates.length) throw new Error('Unable to place countries.');
        initial.push(candidates[0]);
      }
      initial.forEach((tile,i) => { tile.owner=owner; tile.units=[6,4,3][i]; tile.ready=owner === 0 ? tile.units-1 : 0; });
    });
    return state;
  }
  function maxSend(state, fromId, toId) {
    if (state.winner !== null) return 0;
    const from = getTile(state,fromId);
    if (!from || from.owner !== state.currentPlayer) return 0;
    let amount = Math.max(0,Math.min(from.ready,from.units-1));
    if (toId !== undefined && toId !== null) {
      const to = getTile(state,toId);
      if (!to || distance(from,to)!==1) return 0;
      if (to.owner === from.owner) amount = Math.min(amount,9-to.units);
    }
    return amount;
  }
  function previewMove(state, fromId, toId, amount) {
    const fail = error => ({ok:false,error});
    if (state.winner !== null) return fail('This match has ended.');
    const from=getTile(state,fromId), to=getTile(state,toId);
    if (!from || !to) return fail('Choose two tiles on the map.');
    if (from.owner !== state.currentPlayer) return fail('Choose a tile belonging to the current country.');
    if (distance(from,to)!==1) return fail('Dots can move to an adjacent hex only.');
    const maximum=maxSend(state,fromId,toId);
    if(amount===undefined) amount=maximum;
    if (!Number.isInteger(amount) || amount < 1) return fail('Send at least one dot.');
    if (amount > Math.min(from.ready,from.units-1)) return fail('Leave one dot behind; each dot can move once per turn.');
    if (to.owner === from.owner && to.units+amount > 9) return fail('A tile can hold only nine dots.');
    if (amount !== maximum) return fail('Moves always send the maximum available dots.');
    const friendly=to.owner===from.owner;
    const remaining=amount-to.units;
    return {
      ok:true, type:friendly?'transfer':remaining>0?'capture':remaining===0?'clear':'attack',
      player:state.currentPlayer, from:fromId, to:toId, amount,
      sourceRemaining:from.units-amount, attackerRemaining:friendly?amount:Math.max(0,remaining),
      defenderRemaining:friendly?to.units:Math.max(0,-remaining),
      targetUnits:friendly?to.units+amount:Math.abs(remaining),
      targetOwner:friendly||remaining>0?from.owner:remaining===0?-1:to.owner,
      previousOwner:to.owner, losses:friendly?0:Math.min(amount,to.units),
      winner:null
    };
  }
  function applyMove(state,fromId,toId,amount) {
    const event=previewMove(state,fromId,toId,amount);
    if (!event.ok) return event;
    const from=getTile(state,fromId), to=getTile(state,toId);
    from.units-=event.amount;
    from.ready-=event.amount;
    to.units=event.targetUnits;
    to.owner=event.targetOwner;
    to.ready=event.type==='transfer'?Math.min(to.ready,Math.max(0,to.units-1)):0;
    const alive = state.players.map((_,i)=>i).filter(i=>state.tiles.some(t=>t.owner===i));
    if (alive.length===1) { state.winner=alive[0]; event.winner=alive[0]; }
    state.lastEvent=event;
    return event;
  }
  function endTurn(state) {
    if (state.winner !== null) return {ok:false,error:'This match has ended.'};
    const outgoing=state.currentPlayer;
    let growth=0;
    for (const tile of state.tiles) {
      tile.ready=0;
      if (tile.owner===outgoing && tile.units<9) { tile.units++; growth++; }
    }
    const alive = state.players.map((_,i)=>i).filter(i=>state.tiles.some(t=>t.owner===i));
    if (alive.length===1) {
      state.winner=alive[0];
      state.lastEvent={ok:true,type:'endTurn',player:outgoing,nextPlayer:alive[0],growth,winner:alive[0]};
      return state.lastEvent;
    }
    let next=(outgoing+1)%state.players.length;
    while (!alive.includes(next)) next=(next+1)%state.players.length;
    if (next<=outgoing) state.round++;
    state.currentPlayer=next;
    state.turn++;
    for (const tile of state.tiles) if (tile.owner===next) tile.ready=tile.units-1;
    state.lastEvent={ok:true,type:'endTurn',player:outgoing,nextPlayer:next,growth,winner:null};
    return state.lastEvent;
  }
  function connectedCountries(state, owner) {
    const seen=new Set(), result=[];
    for (const tile of state.tiles) {
      if (tile.owner<0 || (owner !== undefined && tile.owner!==owner) || seen.has(tile.id)) continue;
      const ids=[], queue=[tile];
      seen.add(tile.id);
      let units=0;
      while(queue.length) {
        const current=queue.shift(); ids.push(current.id); units+=current.units;
        for (const adjacent of neighbors(state,current)) {
          if (adjacent.owner===tile.owner && !seen.has(adjacent.id)) { seen.add(adjacent.id); queue.push(adjacent); }
        }
      }
      result.push({owner:tile.owner,tiles:ids,size:ids.length,units});
    }
    return result;
  }
  function stats(state) {
    const countries=connectedCountries(state);
    return state.players.map((_,player)=>{
      const tiles=state.tiles.filter(t=>t.owner===player);
      const groups=countries.filter(g=>g.owner===player);
      return {player,tiles:tiles.length,units:tiles.reduce((n,t)=>n+t.units,0),largestCountry:Math.max(0,...groups.map(g=>g.size)),countries:groups.length,ready:tiles.reduce((n,t)=>n+t.ready,0)};
    });
  }
  function chooseAIMove(state) {
    if (state.winner!==null) return null;
    const owner=state.currentPlayer;
    const owned=state.tiles.filter(t=>t.owner===owner);
    const candidates=[];
    const enemyDistance=new Map();
    const queue=[];
    // Multi-source distances route interior dots toward the border without cycling.
    for(const tile of owned) if(neighbors(state,tile).some(t=>t.owner!==owner)) { enemyDistance.set(tile.id,0); queue.push(tile); }
    for(let i=0;i<queue.length;i++) for(const next of neighbors(state,queue[i])) {
      if(next.owner===owner && !enemyDistance.has(next.id)) { enemyDistance.set(next.id,enemyDistance.get(queue[i].id)+1); queue.push(next); }
    }
    for(const from of owned) {
      const movable=maxSend(state,from.id);
      if(!movable) continue;
      for(const to of neighbors(state,from)) {
        const limit=maxSend(state,from.id,to.id);
        if(!limit) continue;
        let score=-Infinity, amount=limit;
        const adjacent=neighbors(state,to);
        if(to.owner!==owner && limit>to.units) {
          const exposed=adjacent.filter(t=>t.owner>=0&&t.owner!==owner);
          const danger=exposed.reduce((n,t)=>Math.max(n,t.units-1),0);
          const enemyBonus=to.owner>=0?22:0;
          score=100+enemyBonus-to.units*5+adjacent.filter(t=>t.owner===owner).length*3;
          if(limit-to.units<=danger) score-=9;
          if(to.owner>=0 && state.tiles.filter(t=>t.owner===to.owner).length===1) score+=45;
        } else if(to.owner!==owner) {
          const supporters=adjacent.filter(t=>t.owner===owner&&t.id!==from.id);
          const followUp=Math.max(0,...supporters.map(t=>maxSend(state,t.id)));
          if(followUp>0 && followUp<=to.units && limit+followUp>to.units) {
            score=55+(to.owner>=0?15:0)-amount*3;
          }
        } else {
          const fromDistance=enemyDistance.get(from.id)??Infinity;
          const toDistance=enemyDistance.get(to.id)??Infinity;
          if(toDistance<fromDistance) score=25-toDistance*3;
          else if(fromDistance===0&&toDistance===0) {
            const fromCanAttack=neighbors(state,from).some(t=>t.owner!==owner&&t.units<movable);
            const toStrongestTarget=Math.min(99,...adjacent.filter(t=>t.owner!==owner).map(t=>t.units));
            // Consolidate a weak border army into a stronger one that can break a defended tile next turn.
            if(!fromCanAttack&&to.units>=from.units&&toStrongestTarget<9&&to.units+limit>toStrongestTarget+1) score=14;
          }
        }
        if(Number.isFinite(score)) {
          score+=(hash(`${state.seed}:${state.turn}:${from.id}:${to.id}`)%100)/1000;
          candidates.push({from:from.id,to:to.id,amount,score});
        }
      }
    }
    candidates.sort((a,b)=>b.score-a.score);
    if(!candidates.length) return null;
    const {from,to,amount}=candidates[0];
    return {from,to,amount};
  }
  function validateState(state) {
    const errors=[];
    if(!state || typeof state!=='object' || Array.isArray(state)) return {ok:false,errors:['Missing game state.']};
    if(state.version!==1&&state.version!==VERSION) errors.push('Unsupported save version.');
    if(![3,4,5].includes(state.radius)) errors.push('Invalid map size.');
    if(typeof state.seed!=='string'||state.seed.length>128) errors.push('Invalid seed.');
    if(!Array.isArray(state.players)||state.players.length<2||state.players.length>4) errors.push('Invalid countries.');
    if(!Array.isArray(state.tiles)||state.tiles.length<12||state.tiles.length>1+3*state.radius*(state.radius+1)) errors.push('Invalid board.');
    if(errors.length) return {ok:false,errors};
    for(const player of state.players) if(!player || typeof player.name!=='string'||player.name.length>24||!/^#[0-9a-f]{6}$/i.test(player.color)||!['human','ai'].includes(player.controller)) errors.push('Invalid country settings.');
    if(!Number.isInteger(state.currentPlayer)||state.currentPlayer<0||state.currentPlayer>=state.players.length) errors.push('Invalid current player.');
    if(!Number.isInteger(state.round)||state.round<1||!Number.isInteger(state.turn)||state.turn<1) errors.push('Invalid turn.');
    if(state.winner!==null&&(!Number.isInteger(state.winner)||state.winner<0||state.winner>=state.players.length)) errors.push('Invalid winner.');
    const seen=new Set();
    for(const tile of state.tiles) {
      if(!tile||!Number.isInteger(tile.q)||!Number.isInteger(tile.r)||Math.max(Math.abs(tile.q),Math.abs(tile.r),Math.abs(tile.q+tile.r))>state.radius||tile.id!==key(tile.q,tile.r)||seen.has(tile.id)) {errors.push('Invalid hex coordinate.');continue;}
      seen.add(tile.id);
      if(!Number.isInteger(tile.owner)||tile.owner < -1||tile.owner>=state.players.length) errors.push('Invalid tile owner.');
      if(!Number.isInteger(tile.units)||tile.units<0||tile.units>9||tile.owner>=0&&tile.units<1) errors.push('Invalid population.');
      if(!Number.isInteger(tile.ready)||tile.ready<0||tile.ready>Math.max(0,tile.units-1)||tile.owner!==state.currentPlayer&&tile.ready!==0) errors.push('Invalid ready dots.');
    }
    if(!errors.length) {
      const visited=new Set([state.tiles[0].id]), queue=[state.tiles[0]];
      for(let i=0;i<queue.length;i++) for(const adjacent of neighbors(state,queue[i])) if(!visited.has(adjacent.id)){visited.add(adjacent.id);queue.push(adjacent);}
      if(visited.size!==state.tiles.length) errors.push('The continent must be connected.');
    }
    const alive=state.players.map((_,i)=>i).filter(i=>state.tiles.some(t=>t?.owner===i));
    if(state.winner===null&&(!alive.includes(state.currentPlayer)||alive.length<2)) errors.push('Invalid active countries.');
    if(state.winner!==null&&(alive.length!==1||alive[0]!==state.winner)) errors.push('Invalid victory.');
    return {ok:errors.length===0,errors:[...new Set(errors)]};
  }
  return Object.freeze({VERSION,DIRECTIONS,COLORS,NAMES,createGame,getTile,neighbors,maxSend,previewMove,applyMove,endTurn,connectedCountries,stats,chooseAIMove,validateState,distance});
});
