/* Dotlands interface. Local play and Doodletick host-authoritative peer rooms. */
(() => {
  'use strict';
  const E = globalThis.DotlandsEngine;
  const $ = id => document.getElementById(id);
  const esc = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const SYMBOLS = ['○','△','◇','✳'];
  const NAMES = ['Moss','Ember','Honey','Iris'];
  const COLORS = ['#78aa8b','#dc917d','#d5b45d','#afa1c7'];
  const SAVE_KEY = 'dotlands.local.v1', ROOM_KEY = 'doodletick.dotlands.room.v1';
  const DEFAULT_SERVER = ''; // Set to your HTTPS room server before building the itch.io release.
  let state = null, mode = 'solo', selected = null, target = null;
  let online = null, room = null, polling = null, busy = false, aiRunning = false, aiGeneration = 0, networkGeneration = 0;
  let peerSession = null, peerConnected = true;
  let shownWinner = false, soundOn = false, audio = null, toastTimer = null, lastFocus = null;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  function readStorage(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function writeStorage(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
  function validSave() { const s = readStorage(SAVE_KEY); return s && E.validateState(s).ok ? s : null; }
  function save() { if (!online && state) writeStorage(SAVE_KEY, state);else if(online&&peerSession)rememberRoom(); }
  function toast(text) { $('toast').textContent=text; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true, 3400); }
  function log(text) { $('event-log').textContent=text; }
  function playTone(type='move') {
    if (!soundOn) return;
    try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume().catch(()=>{}); const t=audio.currentTime; const o=audio.createOscillator(), g=audio.createGain(); o.type='sine'; o.frequency.setValueAtTime(type==='capture'?540:type==='turn'?330:400,t); o.frequency.exponentialRampToValueAtTime(type==='capture'?800:240,t+.12); g.gain.setValueAtTime(.045,t); g.gain.exponentialRampToValueAtTime(.001,t+.17); o.connect(g).connect(audio.destination); o.start(t); o.stop(t+.18); } catch { /* Silent play remains available. */ }
  }
  function openModal(html, locked=false) {
    lastFocus=document.activeElement; $('modal-content').innerHTML=html; $('modal').dataset.locked=String(locked);
    if (!$('modal').open) $('modal').showModal();
  }
  function closeModal() { $('modal').close(); if(lastFocus?.isConnected)lastFocus.focus({preventScroll:true}); }
  $('modal').addEventListener('cancel',e=>{if($('modal').dataset.locked==='true')e.preventDefault();});
  $('modal').addEventListener('click',e=>{if(e.target===$('modal') && $('modal').dataset.locked!=='true')closeModal();});
  function showScreen(id) { const changed=$(id).hidden;for(const x of ['welcome','game','lobby'])$(x).hidden=x!==id;if(changed)window.scrollTo?.(0,0); }
  function stopPolling() { clearTimeout(polling); polling=null; }
  function closePeer() { const old=peerSession;peerSession=null;peerConnected=true;if(old){if(online?.role==='host')writeStorage(ROOM_KEY,null);old.close();}$('connection-status').hidden=true; }
  function menu() {
    if ($('modal').open) closeModal();
    aiGeneration++; networkGeneration++; aiRunning=false; busy=false; save(); stopPolling();closePeer(); online=null;room=null;state=null;showScreen('welcome');
    $('create-room').disabled=$('join-room').disabled=$('start-room').disabled=false;
    $('continue').hidden=!validSave(); $('reconnect').hidden=!readStorage(ROOM_KEY);
  }
  function switchMode(next) {
    mode=next; for(const b of document.querySelectorAll('[data-mode]'))b.setAttribute('aria-selected',String(b.dataset.mode===mode));
    $('local-setup').hidden=mode==='online'; $('online-setup').hidden=mode!=='online'; $('human-field').hidden=mode==='solo';
    $('mode-note').textContent=mode==='solo'?'A new continent. You against the computers.':'Take a turn, pass the phone. Computers fill spare seats.';
    $('start').innerHTML=mode==='solo'?'Take on the world <span>↗</span>':'Let’s make borders <span>↗</span>';
    if(mode==='online' && !$('server-url').value)$('server-details').open=true;
  }
  function updateHumans() {
    const count=+$('country-count').value, old=+$('human-count').value;
    $('human-count').innerHTML=Array.from({length:count-1},(_,i)=>i+2).map(n=>`<option value="${n}">${n} people${count>n?' + '+(count-n)+' computer'+(count-n>1?'s':''):''}</option>`).join('');
    $('human-count').value=String(Math.min(old,count));
  }
  function startLocal() {
    stopPolling();closePeer(); online=null; room=null; aiGeneration++; networkGeneration++; aiRunning=false; busy=false; selected=target=null; shownWinner=false;
    const count=+$('country-count').value, humanCount=mode==='solo'?1:+$('human-count').value;
    const seed=globalThis.crypto?.getRandomValues?crypto.getRandomValues(new Uint32Array(1))[0].toString(36):Date.now().toString(36);
    state=E.createGame({seed,radius:3,players:Array.from({length:count},(_,i)=>({name:NAMES[i],color:COLORS[i],controller:i<humanCount?'human':'ai'}))});
    showScreen('game'); render(); save(); log('Select one of your colored hexes to begin.');
    if(humanCount>1)handoff();
  }
  function current() { return state.players[state.currentPlayer]; }
  function myTurn() { return state && state.winner===null && !busy && (online?peerConnected&&state.currentPlayer===online.seat:current().controller==='human'&&!aiRunning); }
  function lighten(hex, mix=.38) { const n=parseInt(hex.slice(1),16);return '#'+[n>>16,(n>>8)&255,n&255].map(v=>Math.round(v+(244-v)*mix).toString(16).padStart(2,'0')).join(''); }
  function coordinates(t,size=32) { return {x:Math.sqrt(3)*(t.q+t.r/2)*size,y:1.5*t.r*size}; }
  function polygon(x,y,size) {return Array.from({length:6},(_,i)=>{const a=(i*60-30)*Math.PI/180;return `${(x+Math.cos(a)*size).toFixed(2)},${(y+Math.sin(a)*size).toFixed(2)}`;}).join(' ');}
  const DOTS=[[],[[0,0]],[[-5,-5],[5,5]],[[-8,-8],[0,0],[8,8]],[[-6,-6],[6,-6],[-6,6],[6,6]],[[-8,-8],[8,-8],[0,0],[-8,8],[8,8]],[[-7,-9],[7,-9],[-7,0],[7,0],[-7,9],[7,9]],[[-9,-9],[0,-9],[9,-9],[0,0],[-9,9],[0,9],[9,9]],[[-9,-9],[0,-9],[9,-9],[-9,0],[9,0],[-9,9],[0,9],[9,9]],[[-9,-9],[0,-9],[9,-9],[-9,0],[0,0],[9,0],[-9,9],[0,9],[9,9]]];
  function tileMarkup(t, demo=false) {
    const {x,y}=coordinates(t), owned=t.owner>=0, p=owned?state.players[t.owner]:null;
    const adjacent=selected && E.neighbors(state,selected).some(n=>n.id===t.id) && E.maxSend(state,selected,t.id)>0;
    const classes=['hex',!owned?'neutral':'',selected===t.id?'selected':'',target===t.id?'target':'',adjacent?'reachable':''].filter(Boolean).join(' ');
    const fill=owned?lighten(p.color):'#e2e8d6';
    const label=`${owned?p.name:'Independent'} hex ${t.id}, ${t.units} dot${t.units!==1?'s':''}${owned&&t.owner===state.currentPlayer?`, ${E.maxSend(state,t.id)} can move`:''}`;
    return `<g class="${classes}" data-tile="${t.id}"${demo?'':` role="button" tabindex="0" aria-label="${esc(label)}" aria-pressed="${selected===t.id||target===t.id}"`}><polygon points="${polygon(x,y,30)}" fill="${fill}" stroke="${owned?lighten(p.color,.1):'#cad4bc'}" stroke-width="1"/><text x="${x}" y="${y-17}" font-size="8" text-anchor="middle" fill="${owned?'#355040':'#94a186'}">${owned?SYMBOLS[t.owner]:'·'}</text>${DOTS[t.units].map(([dx,dy],i)=>`<circle class="pip${owned&&t.owner===state.currentPlayer&&i>=t.ready?' spent':''}" cx="${x+dx}" cy="${y+dy+3}" r="3.1"/>`).join('')}${t.units===0?`<path d="M${x-4} ${y+3}h8M${x} ${y-1}v8" stroke="#a1ae90" stroke-width="1"/>`:''}</g>`;
  }
  function renderBoard() {
    const points=state.tiles.map(t=>coordinates(t));
    const left=Math.min(...points.map(p=>p.x))-34,top=Math.min(...points.map(p=>p.y))-34;
    const right=Math.max(...points.map(p=>p.x))+34,bottom=Math.max(...points.map(p=>p.y))+34;
    $('board').setAttribute('viewBox',`${left} ${top} ${right-left} ${bottom-top}`);
    $('board').innerHTML=state.tiles.map(t=>tileMarkup(t)).join('');
  }
  function renderStandings() {
    const stats=E.stats(state); $('standings').style.setProperty('--players',state.players.length);
    $('standings').innerHTML=state.players.map((p,i)=>`<div class="country-card ${i===state.currentPlayer?'current':''} ${stats[i].tiles?'':'eliminated'}" style="--country:${p.color}" title="${stats[i].largestCountry} hexes in largest connected country"><span class="country-symbol">${SYMBOLS[i]}</span><div><div class="country-name">${esc(p.name)} <small>${p.controller==='ai'?'AI':online?(online.seat===i?'YOU':'PLAYER'):'P'+(i+1)}</small></div><div class="country-stats">${stats[i].tiles} hex · ${stats[i].units} dots</div></div></div>`).join('');
    $('round-label').textContent='ROUND '+String(state.round).padStart(2,'0');
    $('turn-label').textContent=state.winner!==null?`${state.players[state.winner].name} wins`:`${current().name}’s turn`;
    $('turn-label').style.background=lighten(current().color,.65);
    $('map-seed').textContent=online?'ROOM '+online.code:'MAP '+String(state.seed).slice(0,7).toUpperCase();
  }
  function renderControls() {
    if(state.winner!==null){$('controls').innerHTML=`<div class="instruction"><h2>${esc(state.players[state.winner].name)} takes the continent.</h2><p>A little country became a whole world.</p></div><button id="play-again" class="primary end-turn">Play again ↗</button>`;$('play-again').onclick=menu;return;}
    if(online&&!peerConnected){$('controls').innerHTML='<div class="instruction"><h2>Connection paused.</h2><p>Keep this page open while Doodletick reconnects. The host needs to keep their game open too.</p></div>';return;}
    if(!myTurn()){
      const yours=online?E.stats(state)[online.seat]:null;
      $('controls').innerHTML=`<div class="instruction"><h2>${busy?'Sending your move…':yours&&!yours.tiles?'Your country has fallen.':esc(current().name)+' is thinking'}<span class="thinking"></span></h2><p>${busy?'Waiting for the table to update.':yours&&!yours.tiles?'Stay to see who takes the continent, or start another game.':online?'The map updates automatically. Your turn will appear here.':'The computer follows the same rules you do.'}</p></div>`;
      return;
    }
    if(selected&&target){
      const from=E.getTile(state,selected),to=E.getTile(state,target),amount=E.maxSend(state,selected,target);
      const preview=E.previewMove(state,selected,target,amount);if(!preview.ok){selected=target=null;return renderControls();}
      let title,detail,math,label;
      if(preview.type==='transfer'){title=`Move ${amount} dot${amount===1?'':'s'}`;detail=`Keep ${from.units-amount} behind. Arrivals rest this turn.`;math=`${to.units} + ${amount} = ${to.units+amount} on this hex`;label='Move dots ↗';}
      else {title=`Attack with ${amount} dot${amount===1?'':'s'}`;detail=preview.type==='capture'?`Keep ${from.units-amount} behind. Survivors take the hex.`:preview.type==='clear'?'Both armies are lost. The hex becomes neutral.':`All ${amount} attacking dots will be lost.`;math=`${amount} vs ${to.units} → ${Math.abs(amount-to.units)} ${preview.type==='capture'?'yours':preview.type==='clear'?'survivors':'defenders left'}`;label=preview.type==='capture'?'Capture hex ↗':preview.type==='clear'?'Clear hex ↗':'Attack anyway ↗';}
      $('controls').innerHTML=`<div class="action-panel"><div class="action-info"><h2>${title}</h2><p>${detail}</p><span class="action-math">${math}</span></div><div class="action-buttons"><button id="commit" class="primary">${label}</button><button id="cancel-move" class="text-button">Cancel</button></div></div>`;
      $('commit').onclick=commit;$('cancel-move').onclick=()=>{target=null;render();};
      return;
    }
    const ready=E.stats(state)[state.currentPlayer].ready;
    $('controls').innerHTML=`<div class="instruction"><h2>${selected?'Choose a neighbor.':ready?'Your move, '+esc(current().name)+'.':'Let your country grow.'}</h2><p>${selected?`${E.maxSend(state,selected)} dots ready. We always send the most we can.`:ready?'Tap your hex, then a neighbor. One dot stays behind.':'Your dots are resting. End your turn to grow.'}</p></div><button id="end-turn" class="primary end-turn">End turn <span>↗</span></button>`;
    $('end-turn').onclick=endTurn;
  }
  function render() {if(!state)return;renderStandings();renderBoard();renderControls();if(state.winner!==null&&!shownWinner){shownWinner=true;showWinner();}}
  function pickTile(id) {
    if(!myTurn())return; const tile=E.getTile(state,id);
    if(!selected){if(tile.owner!==state.currentPlayer){toast('Choose one of your own hexes first.');return;}if(!E.maxSend(state,id)){toast('These dots are resting. Try another hex, or end your turn.');return;}selected=id;target=null;}
    else if(id===selected){selected=target=null;}
    else if(E.neighbors(state,selected).some(t=>t.id===id)){
      const max=E.maxSend(state,selected,id);
      if(!max){if(tile.owner===state.currentPlayer&&E.maxSend(state,id)){selected=id;target=null;}else toast('That hex is full. Nine dots is the limit.');}
      else {target=id;}
    }else if(tile.owner===state.currentPlayer&&E.maxSend(state,id)){selected=id;target=null;}
    else{toast('Choose a hex touching your selected hex.');return;}
    playTone();render();
  }
  function describe(event,name) {
    if(event.type==='transfer')return `${name} moved ${event.amount} dots to reinforce a hex.`;
    if(event.type==='capture')return `${name} captured a hex with ${event.attackerRemaining} surviving dot${event.attackerRemaining===1?'':'s'}.`;
    if(event.type==='clear')return `${name} cleared a hex. Both armies were lost; the land is neutral.`;
    return `${name} attacked. ${event.defenderRemaining} defending dot${event.defenderRemaining===1?'':'s'} remain.`;
  }
  async function commit() {
    if(!myTurn()||!selected||!target)return;
    const amount=E.maxSend(state,selected,target);
    const action={type:'move',from:selected,to:target,amount}; const name=current().name;
    const preview=E.previewMove(state,selected,target,amount);if(!preview.ok){toast(preview.error);return;}
    if(online){await remoteAction(action);return;}
    const event=E.applyMove(state,selected,target,amount);if(!event.ok){toast(event.error);return;}
    selected=target=null;save();playTone(event.type);log(describe(event,name));render();
  }
  async function endTurn() {
    if(!myTurn())return;
    selected=target=null;
    if(online){await remoteAction({type:'endTurn'});return;}
    E.endTurn(state);save();playTone('turn');render();log('Reinforcements arrived: +1 dot per held hex, up to nine.');
    if(state.winner!==null)return;
    if(current().controller==='ai')runAI();else if(state.players.filter(p=>p.controller==='human').length>1)handoff();
  }
  async function runAI() {
    if(aiRunning||online||!state)return; aiRunning=true;const generation=++aiGeneration;renderControls();
    try {
      let turns=0;
      while(state.winner===null&&current().controller==='ai'&&generation===aiGeneration&&turns<80){
        const name=current().name;let moves=0;await delay(350);
        while(generation===aiGeneration&&moves<36&&state.winner===null){
          const move=E.chooseAIMove(state);if(!move)break;
          const event=E.applyMove(state,move.from,move.to,move.amount);if(!event.ok)break;
          moves++;log(describe(event,name));render();await delay(turns<4?190:30);
        }
        if(generation!==aiGeneration)return;
        if(state.winner===null)E.endTurn(state);turns++;save();render();
      }
    } finally {if(generation===aiGeneration){aiRunning=false;renderControls();}}
    if(generation!==aiGeneration||state.winner!==null)return;
    if(current().controller==='human'){
      log(`${current().name}’s turn. Your dots are ready.`);playTone('turn');
      if(state.players.filter(p=>p.controller==='human').length>1)handoff();
    }else {log('The computer countries are still fighting.');setTimeout(()=>{if(generation===aiGeneration)runAI();},200);}
  }
  function handoff() {
    const p=current();openModal(`<div class="handoff" style="--country:${p.color}"><div class="eyebrow">PASS THE PHONE · ROUND ${state.round}</div><div class="handoff-symbol">${SYMBOLS[state.currentPlayer]}</div><h2>${esc(p.name)}, you’re up.</h2><p>Your country has ${E.stats(state)[state.currentPlayer].tiles} hexes.<br>Take your time. Make your borders count.</p><button id="ready" class="primary full">I’m ready →</button><button id="handoff-menu" class="text-button">Back to menu</button></div>`,true);
    $('ready').onclick=closeModal;$('handoff-menu').onclick=menu;
  }
  function showWinner() {
    const p=state.players[state.winner],stats=E.stats(state)[state.winner];
    openModal(`<div class="handoff" style="--country:${p.color}"><div class="eyebrow">ONE LITTLE WORLD. ONE LAST COUNTRY.</div><div class="handoff-symbol">${SYMBOLS[state.winner]}</div><h2>${esc(p.name)} wins.</h2><p>${stats.tiles} hexes. ${stats.units} dots. ${state.round} rounds.<br>The last country standing takes the continent.</p><button id="winner-menu" class="primary full">A new little world ↗</button><button id="view-map" class="text-button">Look at the final map</button></div>`);
    $('winner-menu').onclick=menu;$('view-map').onclick=closeModal;
  }
  function showHelp() {
    openModal(`<div class="eyebrow">THE FIELD GUIDE</div><h2>Four little rules.</h2><div class="rule-row"><b>01</b><p><strong>Nine dots per hex. One stays.</strong><br>Every dot is a person. Keep at least one on each hex you own.</p></div><div class="rule-row"><b>02</b><p><strong>Tap yours, then a neighbor.</strong><br>Send the most dots possible. Friendly hexes fill up to nine. Each dot moves once per turn.</p></div><div class="rule-row"><b>03</b><p><strong>The bigger army survives.</strong><br>6 against 4 leaves 2. A tie clears the hex. Smaller attacks weaken defenders but lose their dots.</p></div><div class="rule-row"><b>04</b><p><strong>End your turn to grow.</strong><br>Each held hex gains one dot, up to nine. Be the last country standing.</p></div><p class="fine-print">Every new game has a new continent. Local games save in this browser when storage is available.</p><button id="close-help" class="primary full">Let’s play ↗</button>`);
    $('close-help').onclick=closeModal;
  }
  function baseURL() {
    const raw=$('server-url').value.trim().replace(/\/+$/,'');
    if(!raw)throw new Error('Enter your host’s game server address first.');
    let url;try{url=new URL(raw);}catch{throw new Error('Use a complete server address, starting with https://.');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Use a plain HTTP or HTTPS server address.');
    if(location.protocol==='https:'&&url.protocol!=='https:')throw new Error('This page needs an HTTPS game server.');
    return url.href.replace(/\/+$/,'');
  }
  async function api(path,body,connection=online,timeout=15000) {
    if(peerSession && connection===online && path!=='/health')return peerSession.request(path,body);
    const base=connection?.url||baseURL(),headers={};if(body!==undefined)headers['Content-Type']='application/json';if(connection?.token)headers.Authorization='Bearer '+connection.token;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    try {const response=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store',credentials:'omit'});if([502,503,504].includes(response.status)){const e=new Error('The room server is waking up. Please try again shortly.');e.retryable=true;throw e;}let data;try{data=await response.json();}catch{throw new Error('That address is not a Dotlands game server.');}if(!response.ok){const e=new Error(data.error||'The room could not update.');e.status=response.status;throw e;}return data;}
    catch(e){if(e.name==='AbortError'||e instanceof TypeError){const failure=new Error(e.name==='AbortError'?'The server took too long. It may be waking up; try again.':'Could not connect. Check the server address and your connection.');failure.retryable=true;throw failure;}throw e;}finally{clearTimeout(timer);}
  }
  async function wakeServer(connection,generation) {
    const deadline=Date.now()+75000;let failure;
    $('online-status').textContent='Connecting… The room server may take a minute to wake.';
    while(generation===networkGeneration&&Date.now()<deadline){
      try{const health=await api('/health',undefined,connection,Math.min(15000,deadline-Date.now()));if(generation!==networkGeneration)return false;if(!health?.ok||health.game!=='Dotlands'||health.protocol!==1||health.doodletick!==1)throw new Error('That address is not a Dotlands game server.');return true;}
      catch(e){if(generation!==networkGeneration)return false;if(!e.retryable)throw e;failure=e;$('online-status').textContent='Waking the room server… This can take a minute.';if(Date.now()<deadline)await delay(Math.min(2500,deadline-Date.now()));}
    }
    if(generation!==networkGeneration)return false;
    throw failure||new Error('The room server is still waking up. Please try again.');
  }
  function rememberRoom() {if(online){if(peerSession)Object.assign(online,peerSession.credentials);writeStorage(ROOM_KEY,online);}}
  function peerCallbacks(generation) {
    return {
      onSnapshot(data) {if(generation!==networkGeneration||!online)return;acceptSnapshot(data);},
      onStatus(status) {
        if(generation!==networkGeneration||status.state==='peer-waiting')return;
        const connected=status.state==='connected';
        peerConnected=!['disconnected','closed','error'].includes(status.state);
        const text=connected?(status.transport==='direct'?'Doodletick · Direct peer connection':status.transport==='mixed'?'Doodletick · Direct + connection assist':'Doodletick · Connection assist'):status.reason||(status.state==='closed'?'This room is closed. Start a new room.':'Doodletick · Connecting…');
        $('connection-status').textContent=text;$('connection-status').hidden=false;
        $('connection-status').dataset.transport=status.transport||'';
        if(!peerConnected){$('lobby-status').textContent=text;log(text);}
        if(state&&!$('game').hidden)renderControls();
      }
    };
  }
  function acceptSnapshot(data) {
    if(!data||typeof data.code!=='string'||!Number.isInteger(data.revision)||data.revision<1||!Number.isInteger(data.seat)||data.seat<0||data.seat>3||!Array.isArray(data.players)||data.players.length<1||data.players.length>4||!['lobby','playing'].includes(data.phase)||data.maxPlayers<2||data.maxPlayers>4||data.hostSeat!==0)throw new Error('The room sent an invalid update.');
    if(data.players.some(p=>!p||typeof p.name!=='string'||p.name.length>22||!Number.isInteger(p.seat)||p.seat<0||p.seat>3)||new Set(data.players.map(p=>p.seat)).size!==data.players.length)throw new Error('The room sent invalid players.');
    if(data.phase==='playing'&&!E.validateState(data.state).ok)throw new Error('The room sent an invalid game.');
    if(room&&room.code===data.code&&room.revision>data.revision)return;
    const changed=!room||room.revision!==data.revision,oldTurn=state?.turn;room=data;
    if(online)online.seat=data.seat;
    if(data.phase==='lobby'){showScreen('lobby');renderLobby();return;}
    if(changed||$('game').hidden){state=data.state;selected=target=null;showScreen('game');render();if(oldTurn!==state.turn)log(`${current().name}’s turn. ${current().controller==='ai'?'Computer is playing.':'The table is up to date.'}`);}
  }
  function schedulePoll(ms=1700) {stopPolling();if(online)polling=setTimeout(pollRoom,ms);}
  async function pollRoom() {
    if(!online)return; const connection=online;
    if(busy){schedulePoll();return;}
    try {const data=await api('/rooms/'+connection.code,undefined,connection);if(online!==connection)return;acceptSnapshot(data);if(!state||state.winner===null)schedulePoll(document.hidden?5000:1700);}
    catch(e){if(online!==connection)return;if(e.status===401||e.status===404){stopPolling();toast(e.message);$('lobby-status').textContent=e.message;log(e.message);return;}$('lobby-status').textContent='Connection interrupted. Trying again…';log('Connection interrupted. Reconnecting to your room…');schedulePoll(4000);}
  }
  async function enterRoom(join) {
    if(busy)return;const generation=++networkGeneration;busy=true;$('online-status').textContent='Connecting to your table…';$('create-room').disabled=$('join-room').disabled=true;
    try {const url=baseURL(),name=$('player-name').value.trim()||'Player';if(name.length>22)throw new Error('Keep your name to 22 characters or fewer.');const code=$('room-code').value.trim().toUpperCase();if(join&&!/^[A-Z2-9]{6}$/.test(code))throw new Error('Enter the six-character room code.');const connection={url};if(!await wakeServer(connection,generation))return;
      const session=await globalThis.DotlandsRoom[join?'join':'create']({url,room:code,name,...peerCallbacks(generation)});
      if(generation!==networkGeneration){session.close();return;}
      peerSession=session;aiGeneration++;aiRunning=false;online={url,...session.credentials};room=null;state=null;shownWinner=false;rememberRoom();acceptSnapshot(session.initial);schedulePoll();}
    catch(e){if(generation===networkGeneration)$('online-status').textContent=e.message;}finally{if(generation===networkGeneration){busy=false;$('create-room').disabled=$('join-room').disabled=false;}}
  }
  function renderLobby() {
    $('lobby-code').textContent=room.code;
    $('lobby-seats').innerHTML=Array.from({length:room.maxPlayers},(_,i)=>{const p=room.players.find(p=>p.seat===i);return `<div class="lobby-seat"><span>${SYMBOLS[i]} &nbsp; ${p?esc(p.name):'Open seat'}</span><span>${p?(i===online.seat?'You':i===0?'Host':'Ready'):'Computer if empty'}</span></div>`;}).join('');
    $('start-room').hidden=online.seat!==room.hostSeat;
    $('lobby-status').textContent=online.seat===room.hostSeat?'Keep this game open while friends play. Empty seats become computers.':'Waiting for the host to start. Keep both games open.';
  }
  async function startRoom() {
    if(busy||!online)return;const connection=online;busy=true;$('start-room').disabled=true;
    try{const data=await api('/rooms/'+connection.code+'/start',{expectedRevision:room.revision,fillBots:true},connection);if(online!==connection)return;acceptSnapshot(data);schedulePoll();}
    catch(e){if(online===connection){toast(e.message);await refreshRoom(connection);}}finally{if(online===connection){busy=false;$('start-room').disabled=false;if(state)renderControls();}}
  }
  async function refreshRoom(connection=online) {if(connection){try{const data=await api('/rooms/'+connection.code,undefined,connection);if(online===connection)acceptSnapshot(data);}catch{}}}
  async function remoteAction(action) {
    busy=true;renderControls();const connection=online;
    try {const data=await api('/rooms/'+connection.code+'/action',{expectedRevision:room.revision,...action},connection);if(online!==connection)return;selected=target=null;acceptSnapshot(data);playTone(action.type==='move'?'capture':'turn');if(action.type==='move'&&state.lastEvent)log(describe(state.lastEvent,state.players[online.seat].name));}
    catch(e){if(online===connection){toast(e.status===409?'The table changed. Your map has been refreshed.':e.message);await refreshRoom(connection);}}
    finally{if(online===connection){busy=false;if(state&&!$('game').hidden)renderControls();schedulePoll();}}
  }
  async function reconnect() {
    const saved=readStorage(ROOM_KEY);if(!saved||busy)return;const generation=++networkGeneration;online=saved;room=null;state=null;shownWinner=false;busy=true;aiGeneration++;aiRunning=false;
    try{if(!await wakeServer(saved,generation))return;const session=await globalThis.DotlandsRoom.reconnect({...saved,...peerCallbacks(generation)});if(generation!==networkGeneration||online!==saved){session.close();return;}peerSession=session;online={url:saved.url,...session.credentials};rememberRoom();acceptSnapshot(session.initial);schedulePoll();}catch(e){if(generation===networkGeneration){$('online-status').textContent=e.message;toast(e.message);online=null;}}finally{if(generation===networkGeneration){busy=false;if(state)renderControls();}}
  }
  async function copyInvite() {
    const invite=new URL(online.url+'/');invite.searchParams.set('room',online.code);
    const text=`Join my Dotlands room: ${online.code}\n${invite.href}`;
    try {await navigator.clipboard.writeText(text);toast('Invitation copied. Send it to your friends.');}
    catch {openModal(`<div class="eyebrow">INVITE YOUR FRIENDS</div><h2>Room ${esc(online.code)}</h2><p>Share this link:</p><input id="invite-link" readonly value="${esc(invite.href)}"><button id="close-invite" class="primary full">Done</button>`);$('invite-link').select();$('close-invite').onclick=closeModal;}
  }
  function hero() {
    const saved=state;state=E.createGame({seed:'hello',players:NAMES.map((name,i)=>({name,color:COLORS[i]}))});
    const demo=state.tiles.filter(t=>Math.max(Math.abs(t.q),Math.abs(t.r),Math.abs(t.q+t.r))<=2).map(t=>({...t,owner:t.q<0?0:t.r>0?1:t.r<0?2:-1,units:1+((t.q*7+t.r*3+30)%6),ready:9}));
    $('hero-map').innerHTML=`<svg viewBox="-170 -135 340 270"><g transform="rotate(-12)">${demo.map(t=>tileMarkup(t,true)).join('')}</g></svg>`;state=saved;
  }
  $('board').addEventListener('click',e=>{const tile=e.target.closest('[data-tile]');if(tile)pickTile(tile.dataset.tile);});
  $('board').addEventListener('keydown',e=>{const tile=e.target.closest('[data-tile]');if(tile&&(e.key==='Enter'||e.key===' ')){e.preventDefault();pickTile(tile.dataset.tile);}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('modal').open){selected=target=null;if(state)render();}});
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>switchMode(b.dataset.mode));
  $('country-count').onchange=updateHumans;$('start').onclick=startLocal;$('help').onclick=showHelp;$('home').onclick=menu;$('menu').onclick=menu;
  $('sound').onclick=()=>{soundOn=!soundOn;$('sound-line').hidden=soundOn;$('sound').setAttribute('aria-label',soundOn?'Turn sound off':'Turn sound on');playTone();};
  $('continue').onclick=()=>{const saved=validSave();if(!saved){toast('No saved game was found.');return;}networkGeneration++;closePeer();online=null;room=null;stopPolling();state=saved;selected=target=null;shownWinner=false;busy=false;showScreen('game');render();if(state.winner===null){if(current().controller==='ai')runAI();else if(state.players.filter(p=>p.controller==='human').length>1)handoff();}};
  $('create-room').onclick=()=>enterRoom(false);$('join-room').onclick=()=>enterRoom(true);$('start-room').onclick=startRoom;$('copy-room').onclick=copyInvite;$('leave-lobby').onclick=menu;$('reconnect').onclick=reconnect;
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&online&&!$('welcome').hidden)return;if(!document.hidden&&online)schedulePoll(50);else if(!online)save();});
  window.addEventListener('pagehide',save);
  const params=new URLSearchParams(location.search),stored=readStorage(ROOM_KEY);
  $('server-url').value=params.get('server')||DEFAULT_SERVER||stored?.url||(/^https?:$/.test(location.protocol)&&!/(?:itch\.io|hwcdn\.net|itch\.zone)$/.test(location.hostname)?location.origin:'');
  $('room-code').value=(params.get('room')||'').toUpperCase().slice(0,6);$('player-name').maxLength=22;
  $('continue').hidden=!validSave();$('reconnect').hidden=!stored;updateHumans();hero();switchMode(params.has('room')?'online':'solo');
})();
