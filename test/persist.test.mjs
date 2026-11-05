import { APP_URL, installDom, makeStore, sleep, text, findButton } from './harness.mjs';
let pass=0,fail=0;
const check=(n,c,d)=>{if(c){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(d?' :: '+d:''));}};
const WK='weekly-state-v2';
const roster=[];
for(let i=0;i<20;i++) roster.push({id:`p${i}`,name:`Player ${i}`,sex:i%2?'F':'M',cta:3.5,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null});

// A store whose writes take time, so two in flight can land out of order - exactly what
// a phone on club wifi does.
function slowStore(seed,delayFor){
  const s=makeStore(seed);
  const realSet=s.set.bind(s);
  s.set=async(k,v)=>{ const d=delayFor?delayFor(k,v):0; if(d) await new Promise(r=>setTimeout(r,d)); return realSet(k,v); };
  return s;
}
async function boot(store){
  installDom(); global.window.storage=store;
  const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
  const m=await import(`${APP_URL}?t=${Math.random()}`);
  const c=global.document.getElementById('root');const root=createRoot(c);
  await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(90);});
  return {c,act};
}
const click=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});await act(async()=>{await sleep(35);});};
const tapFast=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});};

console.log('\n=== A generated sheet survives later writes ===\n');

// The reported loss: generate, then keep using the app. The schedule must not be clobbered.
{
  // First write of a schedule is slow; everything after is quick - so a later save
  // would land first under the old code.
  let seenSchedule=false;
  const store=slowStore({'player-directory':JSON.stringify(roster)},(k,v)=>{
    if(k.startsWith(WK) && /"generatedFor"/.test(v) && !seenSchedule){ seenSchedule=true; return 120; }
    return 0;
  });
  const {c,act}=await boot(store);
  for(let i=0;i<8;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  // ...and immediately carry on, before the slow write has landed
  await click(act,findButton(c,'Today'));
  const extra=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes('Player 9'));
  await tapFast(act,extra);
  await act(async()=>{await sleep(400);});

  const id=global.localStorage.getItem('court-call-device-id');
  const st=JSON.parse(store._docs.get(`${WK}:${id}`));
  check('the schedule survives a write that followed it',!!st.schedule,JSON.stringify(st.schedule===null));
  check('and it is the generated one, stamped',!!(st.schedule&&st.schedule.generatedFor),String(st.schedule&&st.schedule.generatedFor));
  check('the later change is kept too',st.playingIds.includes('p9'),JSON.stringify(st.playingIds.length));
  check('nothing was dropped from the roster',st.playingIds.length===9,String(st.playingIds.length));
}

// A burst of marks must all land - no write racing another
{
  const store=slowStore({'player-directory':JSON.stringify(roster)},(k)=>k.startsWith(WK)?25:0);
  const {c,act}=await boot(store);
  for(let i=0;i<12;i++){
    const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));
    await tapFast(act,r);            // no waiting between taps
  }
  await act(async()=>{await sleep(700);});
  const id=global.localStorage.getItem('court-call-device-id');
  const st=JSON.parse(store._docs.get(`${WK}:${id}`));
  check('twelve fast taps all persist',st.playingIds.length===12,`${st.playingIds.length} of 12: ${JSON.stringify(st.playingIds)}`);
  check('and the screen agrees',text(c).includes('Playing today (12)'),text(c).slice(0,200));
}

// Generating then sharing must not lose the sheet either
{
  const store=slowStore({'player-directory':JSON.stringify(roster)},(k)=>k.startsWith(WK)?60:0);
  const {c,act}=await boot(store);
  for(let i=0;i<8;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(250);});
  // a re-roll straight after, as the organizer does constantly
  await click(act,findButton(c,'Re-roll pairings'));
  await act(async()=>{await sleep(300);});
  const id=global.localStorage.getItem('court-call-device-id');
  const st=JSON.parse(store._docs.get(`${WK}:${id}`));
  check('a re-roll leaves a schedule stored',!!st.schedule);
  const inSheet=new Set();
  st.schedule.rounds.forEach(r=>{r.matches.forEach(m=>[...m.teamA,...m.teamB].forEach(x=>inSheet.add(x)));(r.sittingOut||[]).forEach(x=>inSheet.add(x));});
  check('holding exactly who is marked in',st.playingIds.every(x=>inSheet.has(x))&&[...inSheet].every(x=>st.playingIds.includes(x)),JSON.stringify([...inSheet]));
}

// A failed save must say so rather than pass silently
{
  const store=makeStore({'player-directory':JSON.stringify(roster)});
  const {c,act}=await boot(store);
  for(let i=0;i<4;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  store.set=async()=>{throw new Error('offline');};
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(2200);});   // two retries with backoff before it gives up
  check("a failed save is reported",/NOT saved|didn't save/.test(text(c)),text(c).slice(0,400));
}

console.log('\n=== A save that does not stick ===\n');

// A flaky write that succeeds on retry must not bother anyone
{
  let n=0;
  const store=makeStore({'player-directory':JSON.stringify(roster)});
  const realSet=store.set.bind(store);
  store.set=async(k,v)=>{ if(k.startsWith(WK)&&/"generatedFor"/.test(v)&&n++<1) throw new Error('blip'); return realSet(k,v); };
  const {c,act}=await boot(store);
  for(let i=0;i<8;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(1400);});
  const id=global.localStorage.getItem('court-call-device-id');
  const st=JSON.parse(store._docs.get(`${WK}:${id}`));
  check('a one-off failure is retried and the sheet lands',!!st.schedule,'');
  check('and nothing alarming is shown',!/NOT saved/.test(text(c)),text(c).slice(0,300));
}

// A write that reports success but does not persist - the reported symptom
{
  const store=makeStore({'player-directory':JSON.stringify(roster)});
  const realSet=store.set.bind(store);
  store.set=async(k,v)=>{
    if(k.startsWith(WK)&&/"generatedFor"/.test(v)){
      // pretend it worked, but drop the schedule - exactly what the live data looks like
      const o=JSON.parse(v); o.schedule=null; return realSet(k,JSON.stringify(o));
    }
    return realSet(k,v);
  };
  const {c,act}=await boot(store);
  for(let i=0;i<8;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(2200);});
  const t=text(c);
  check('a sheet that silently fails to save is caught by reading it back',/NOT saved/.test(t),t.slice(0,400));
  check('it says nobody else can see them',/nobody else can see them/.test(t),t.slice(0,400));
  check('and it cannot be dismissed away',!/Dismiss/.test(t.slice(0,t.indexOf('NOT saved')+200)),t.slice(0,400));
}


console.log('\n=== Sharing waits for the save ===\n');

// THE REPORTED FAILURE: generate, then share before the write has landed.
// A backgrounded browser can lose an unfinished write without any error, so the share
// must not go out until the sheet is actually in the database.
{
  let resolveWrite;
  const store=makeStore({'player-directory':JSON.stringify(roster)});
  const realSet=store.set.bind(store);
  store.set=async(k,v)=>{
    if(k.startsWith(WK)&&/"generatedFor"/.test(v)){
      await new Promise(r=>{ resolveWrite=()=>r(); });   // hangs, like a frozen tab
      return realSet(k,v);
    }
    return realSet(k,v);
  };
  const shared=[];
  installDom();
  Object.defineProperty(global.navigator,'share',{value:async(d)=>{shared.push(d);},configurable:true});
  Object.defineProperty(global.navigator,'canShare',{value:()=>true,configurable:true});
  global.window.File=global.File=class File{constructor(b,n,o){this.name=n;this.type=(o||{}).type;}};
  global.atob=(b)=>Buffer.from(b,'base64').toString('binary');
  const stubOps=[];
  const ctx={ set font(v){}, get font(){return '';}, fillStyle:'',strokeStyle:'',lineWidth:1,
    scale(){},fillRect(){},strokeRect(){},fillText(t){stubOps.push(t);},measureText:(t)=>({width:t.length*14})};
  const realCreate=global.document.createElement.bind(global.document);
  global.document.createElement=(t)=>t==='canvas'
    ? {width:0,height:0,getContext:()=>ctx,toDataURL:()=>'data:image/png;base64,aGk='}
    : realCreate(t);
  global.window.storage=store;
  const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
  const m=await import(`${APP_URL}?t=${Math.random()}`);
  const c=global.document.getElementById('root');const root=createRoot(c);
  await act(async()=>{root.render(React.createElement(m.default));});
  await act(async()=>{await sleep(90);});
  for(let i=0;i<8;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await tapFast(act,findButton(c,'Generate Pairings'));     // write hangs
  await act(async()=>{await sleep(60);});
  const shareBtn=[...c.querySelectorAll('button')].find(b=>/Share the sheet|Saving the sheet/.test(b.textContent||''));
  check('the sheet is on screen straight away',/SET 1/.test(text(c)),text(c).slice(0,250));
  await tapFast(act,shareBtn);
  await act(async()=>{await sleep(120);});
  check('sharing does not go out while the save is in flight',shared.length===0,String(shared.length));
  check('and it says it is saving',/Saving the sheet/.test(text(c)),text(c).slice(0,400));
  // let the write finish
  resolveWrite();
  await act(async()=>{await sleep(400);});
  check('once saved, the share completes',shared.length===1,String(shared.length));
  const id=global.localStorage.getItem('court-call-device-id');
  check('and the sheet is in the database',!!JSON.parse(store._docs.get(`${WK}:${id}`)).schedule);
}

// A sheet that truly cannot save must not be shared at all
{
  const store=makeStore({'player-directory':JSON.stringify(roster)});
  const realSet=store.set.bind(store);
  store.set=async(k,v)=>{ if(k.startsWith(WK)&&/"generatedFor"/.test(v)) throw new Error('offline'); return realSet(k,v); };
  const shared=[];
  installDom();
  Object.defineProperty(global.navigator,'share',{value:async(d)=>{shared.push(d);},configurable:true});
  Object.defineProperty(global.navigator,'canShare',{value:()=>true,configurable:true});
  global.window.File=global.File=class File{constructor(b,n,o){this.name=n;}};
  global.atob=(b)=>Buffer.from(b,'base64').toString('binary');
  const ctx={ set font(v){}, get font(){return '';}, fillStyle:'',strokeStyle:'',lineWidth:1,
    scale(){},fillRect(){},strokeRect(){},fillText(){},measureText:(t)=>({width:t.length*14})};
  const realCreate=global.document.createElement.bind(global.document);
  global.document.createElement=(t)=>t==='canvas'
    ? {width:0,height:0,getContext:()=>ctx,toDataURL:()=>'data:image/png;base64,aGk='}
    : realCreate(t);
  global.window.storage=store;
  const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
  const m=await import(`${APP_URL}?t=${Math.random()}`);
  const c=global.document.getElementById('root');const root=createRoot(c);
  await act(async()=>{root.render(React.createElement(m.default));});
  await act(async()=>{await sleep(90);});
  for(let i=0;i<8;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(2400);});
  const shareBtn=[...c.querySelectorAll('button')].find(b=>/Share the sheet/.test(b.textContent||''));
  await click(act,shareBtn);
  await act(async()=>{await sleep(200);});
  check('an unsaved sheet is never shared',shared.length===0,String(shared.length));
  const t=text(c);
  check('and the refusal explains why',/nobody else can open/.test(t),t.slice(0,500));
  check('pointing at how to fix it',/Re-roll pairings/.test(t),t.slice(0,500));
}

console.log('\n=== Two copies of the app in one browser ===\n');

// The 5 Nov document: today's 16 players beside the previous session's schedule.
// Two tabs (or a home-screen app and a browser tab) share localStorage, so they share a
// device id and write the same document - each from its own memory. A copy opened before
// the new sheet still holds the old schedule, and its next tap writes it back.
{
  installDom();
  const store=makeStore({'player-directory':JSON.stringify(roster)});
  global.window.storage=store;
  const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
  const m=await import(`${APP_URL}?t=${Math.random()}`);   // one module: one device id, as in one browser
  const playerBtn=(c,i)=>[...c.querySelectorAll('button')].find(x=>new RegExp(`Player ${i}(?!\\d)`).test(x.textContent||''));
  const cA=global.document.getElementById('root');
  const cB=global.document.createElement('div'); global.document.body.appendChild(cB);

  // Tab A: last session's sheet, 8 players
  await act(async()=>{createRoot(cA).render(React.createElement(m.default));}); await act(async()=>{await sleep(90);});
  for(let i=0;i<8;i++) await click(act,playerBtn(cA,i));
  await click(act,findButton(cA,'Courts'));
  await click(act,findButton(cA,'Generate Pairings'));
  await act(async()=>{await sleep(200);});
  // Still in tab A, this session's people reply and are marked in
  await click(act,findButton(cA,'Today'));
  for(let i=8;i<16;i++) await click(act,playerBtn(cA,i));
  await act(async()=>{await sleep(100);});

  // Tab B opens, generates for all 16, and the save is confirmed
  await act(async()=>{createRoot(cB).render(React.createElement(m.default));}); await act(async()=>{await sleep(120);});
  await click(act,findButton(cB,'Courts'));
  await click(act,findButton(cB,'Generate Pairings'));
  await act(async()=>{await sleep(200);});
  const id=global.localStorage.getItem('court-call-device-id');
  const KEY=`${WK}:${id}`;
  const inSheet=(st)=>{const s=new Set();(st.schedule?st.schedule.rounds:[]).forEach(r=>{r.matches.forEach(x=>[...x.teamA,...x.teamB].forEach(p=>s.add(p)));(r.sittingOut||[]).forEach(p=>s.add(p));});return s;};
  const afterB=JSON.parse(store._docs.get(KEY));
  check('tab B saved the 16-player sheet',inSheet(afterB).size===16,String(inSheet(afterB).size));

  // Back in tab A, still showing the old sheet, one more tap: a late arrival
  await click(act,findButton(cA,'Today'));
  await click(act,playerBtn(cA,16));
  await act(async()=>{await sleep(150);});
  const fin=JSON.parse(store._docs.get(KEY));
  // Tab A's tap was made against a sheet it hadn't seen, so it is dropped, not merged
  check("the stored ids are tab B's 16",fin.playingIds.length===16&&!fin.playingIds.includes('p16'),JSON.stringify(fin.playingIds));
  check("tab A's tap does not put the old 8-player schedule back",inSheet(fin).size===16,
    `stored schedule has ${inSheet(fin).size} players: ${JSON.stringify([...inSheet(fin)])}`);
  check('tab A says the sheet changed elsewhere',/changed in another tab or window/.test(text(cA)),text(cA).slice(0,300));
  check('every save carries its audit fields',fin.rev>=1&&!!fin.writeId&&!!fin.writer,JSON.stringify({rev:fin.rev,writeId:fin.writeId,writer:fin.writer}));
}

// Coming back to a copy picks up what another copy saved, before any tap
{
  installDom();
  const store=makeStore({'player-directory':JSON.stringify(roster)});
  global.window.storage=store;
  const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
  const m=await import(`${APP_URL}?t=${Math.random()}`);
  const playerBtn=(c,i)=>[...c.querySelectorAll('button')].find(x=>new RegExp(`Player ${i}(?!\\d)`).test(x.textContent||''));
  const cA=global.document.getElementById('root');
  const cB=global.document.createElement('div'); global.document.body.appendChild(cB);
  await act(async()=>{createRoot(cA).render(React.createElement(m.default));}); await act(async()=>{await sleep(90);});
  await act(async()=>{createRoot(cB).render(React.createElement(m.default));}); await act(async()=>{await sleep(90);});
  for(let i=0;i<8;i++) await click(act,playerBtn(cB,i));
  await act(async()=>{await sleep(100);});
  check('before returning, tab A has not seen tab B',!/Playing today \(8\)/.test(text(cA)),text(cA).slice(0,200));
  await act(async()=>{global.document.dispatchEvent(new global.window.Event('visibilitychange'));});
  await act(async()=>{await sleep(100);});
  check('on return, tab A shows the 8 marked in tab B',/Playing today \(8\)/.test(text(cA)),text(cA).slice(0,200));
}

// One copy alone never trips the check on its own saves
{
  const store=makeStore({'player-directory':JSON.stringify(roster)});
  const {c,act}=await boot(store);
  for(let i=0;i<6;i++) await tapFast(act,[...c.querySelectorAll('button')].find(x=>new RegExp(`Player ${i}(?!\\d)`).test(x.textContent||'')));
  await act(async()=>{await sleep(300);});
  const id=global.localStorage.getItem('court-call-device-id');
  const st=JSON.parse(store._docs.get(`${WK}:${id}`));
  check('a single copy saves every tap',st.playingIds.length===6,String(st.playingIds.length));
  check('with no false alarm',!/another tab or window/.test(text(c)),text(c).slice(0,200));
  check('and rev counts each save',st.rev===6,String(st.rev));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
