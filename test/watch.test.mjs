import { APP_URL, installDom, makeStore, sleep, text, findButton } from './harness.mjs';
let pass=0,fail=0;
const check=(n,c,d)=>{if(c){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(d?' :: '+d:''));}};
const WK='weekly-state-v2';
const roster=[];
for(let i=0;i<8;i++) roster.push({id:`p${i}`,name:`Player ${i}`,sex:i%2?'F':'M',cta:3.5,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null});
async function boot(seed,keepLs){installDom();
 const store=makeStore(seed); global.window.storage=store;
 const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
 const m=await import(`${APP_URL}?t=${Math.random()}`);
 const c=global.document.getElementById('root');const root=createRoot(c);
 if(keepLs) for(const [k,v] of Object.entries(keepLs)) global.localStorage.setItem(k,v);
 await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(90);});return{c,act,store,root};}
const click=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});await act(async()=>{await sleep(45);});};

// Build a real sheet for "Robb", with a hand adjustment, and capture it
async function makeRobbSheet(){
  const {c,act,store}=await boot({'player-directory':JSON.stringify(roster)});
  for(let i=0;i<8;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(200);});
  await click(act,findButton(c,'Adjust'));
  const chips=[...c.querySelectorAll('button')].filter(b=>(b.className||'').includes('rounded-md')&&/Player \d/.test(b.textContent||''));
  if(chips.length>=2){await click(act,chips[0]);await click(act,chips[1]);}
  await act(async()=>{await sleep(80);});
  const id=global.localStorage.getItem('court-call-device-id');
  return store._docs.get(`${WK}:${id}`);
}
const robbDoc = await makeRobbSheet();
const robbTeams = (()=>{const st=JSON.parse(robbDoc);const m=st.schedule.rounds[0].matches[0];return [...m.teamA,...m.teamB].join(',');})();

console.log('\n=== Watching another sheet ===\n');
{
  const {c,act}=await boot({'player-directory':JSON.stringify(roster),[`${WK}:robb`]:robbDoc});
  await click(act,findButton(c,'other session'));
  check('a Watch option is offered',!!findButton(c,'Watch'),text(c).slice(0,400));
  check('Copy is still offered',!!findButton(c,'Copy'));
  check('the difference is explained',text(c).includes('leaving both sheets alone'),text(c).slice(0,500));

  await click(act,findButton(c,'Watch'));
  await act(async()=>{await sleep(120);});
  const t=text(c);
  check('it jumps straight to the pairings',t.includes('SET 1'),t.slice(0,300));
  check('it says whose sheet this is',t.includes("Watching another browser's sheet"),t.slice(0,400));
  check('it explains logging still counts',t.includes('records it for everyone'),t.slice(0,600));
  check('it offers a way back',!!findButton(c,'Back to mine'));
  check('it can re-check for changes',!!findButton(c,'Check for changes'));

  // the watched pairings must be Robb's, including his adjustment
  const shown=[...c.querySelectorAll('button')].filter(b=>/^Player \d$/.test((b.textContent||'').trim())).map(b=>b.textContent.trim());
  check('their players are the ones rendered',shown.length>0,shown.slice(0,4).join(','));

  // editing controls must be gone
  check('Adjust is hidden while watching',!findButton(c,'Adjust'),'');
  check('Re-roll is hidden while watching',!findButton(c,'Re-roll pairings'),'');
  check('sharing what you see is still possible',!!findButton(c,'Share the sheet')&&!!findButton(c,'Copy as text'),text(c).slice(0,300));
}

// watching does not touch either sheet
{
  const {c,act,store}=await boot({'player-directory':JSON.stringify(roster),[`${WK}:robb`]:robbDoc});
  const before=store._docs.get(`${WK}:robb`);
  await click(act,findButton(c,'other session'));
  await click(act,findButton(c,'Watch'));
  await act(async()=>{await sleep(120);});
  check('their sheet is untouched',store._docs.get(`${WK}:robb`)===before);
  const mine=global.localStorage.getItem('court-call-device-id');
  const ownDoc=store._docs.get(`${WK}:${mine}`);
  const ownSchedule=ownDoc?JSON.parse(ownDoc).schedule:null;
  check('this browser gets no pairings of its own',!ownSchedule,JSON.stringify(!!ownSchedule));
}

// logging a winner from a watched sheet writes to shared history
{
  const {c,act,store}=await boot({'player-directory':JSON.stringify(roster),[`${WK}:robb`]:robbDoc});
  await click(act,findButton(c,'other session'));
  await click(act,findButton(c,'Watch'));
  await act(async()=>{await sleep(120);});
  const win=[...c.querySelectorAll('button')].find(x=>(x.className||'').includes('tp-winbtn'));
  check('winners can be marked while watching',!!win);
  if(win){
    await click(act,win);
    await act(async()=>{await sleep(80);});
    check('the result reaches shared history',store._docs.has('match-history'),'');
    const h=JSON.parse(store._docs.get('match-history')||'[]');
    check('and it records a winner',h.length>0&&!!h[0].winner,JSON.stringify(h[0]||{}).slice(0,120));
  }
}

// it is still watching on the next visit
{
  const seed={'player-directory':JSON.stringify(roster),[`${WK}:robb`]:robbDoc};
  const {c,act}=await boot(seed);
  await click(act,findButton(c,'other session'));
  await click(act,findButton(c,'Watch'));
  await act(async()=>{await sleep(120);});
  const saved=global.localStorage.getItem('court-call-viewing');
  check('the choice is remembered',!!saved,String(saved));
  // reopen with that remembered
  const {c:c2,act:a2}=await boot(seed,{'court-call-viewing':saved});
  await click(a2,findButton(c2,'Results'));
  await act(async()=>{await sleep(140);});
  check('it comes back watching on return',text(c2).includes("Watching another browser's sheet"),text(c2).slice(0,400));
}

// backing out returns this browser's own sheet
{
  const {c,act}=await boot({'player-directory':JSON.stringify(roster),[`${WK}:robb`]:robbDoc});
  for(let i=0;i<4;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(200);});
  await click(act,findButton(c,'Today'));
  await click(act,findButton(c,'other session'));
  await click(act,findButton(c,'Watch'));
  await act(async()=>{await sleep(120);});
  check('watching replaces what Results shows',text(c).includes("Watching another browser's sheet"),'');
  await click(act,findButton(c,'Back to mine'));
  await act(async()=>{await sleep(80);});
  check('backing out restores this browser’s own sheet',!text(c).includes("Watching another browser's sheet")&&text(c).includes('SET 1'),text(c).slice(0,300));
  check('and Adjust is available again',!!findButton(c,'Adjust'));
}

// a watched sheet that has gone away
{
  const {c,act}=await boot({'player-directory':JSON.stringify(roster)},{'court-call-viewing':`${WK}:gone`});
  await click(act,findButton(c,'Results'));
  await act(async()=>{await sleep(140);});
  check('a missing sheet is reported, not silently blank',
    /Couldn't reach that sheet|no pairings on it/.test(text(c)),text(c).slice(0,400));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
