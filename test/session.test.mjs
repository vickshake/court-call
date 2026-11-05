import { APP_URL, installDom, makeStore, sleep, text, findButton } from './harness.mjs';
let pass=0,fail=0;
const check=(n,c,d)=>{if(c){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(d?' :: '+d:''));}};
const WK='weekly-state-v2';
const roster=[];
for(let i=0;i<16;i++) roster.push({id:`p${i}`,name:`Player ${i}`,sex:i%2?'F':'M',cta:3.5,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null});
async function boot(seed){installDom();
 const store=makeStore(seed); global.window.storage=store;
 const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
 const m=await import(`${APP_URL}?t=${Math.random()}`);
 const c=global.document.getElementById('root');const root=createRoot(c);
 await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(90);});return{c,act,store};}
const click=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});await act(async()=>{await sleep(45);});};
const toggle=async(c,act,i)=>{const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));if(r)await click(act,r);};
const setDate=async(c,act,iso)=>{const d=c.querySelector('input[type="date"]');
 await act(async()=>{Object.getOwnPropertyDescriptor(global.window.HTMLInputElement.prototype,'value').set.call(d,iso);d.dispatchEvent(new global.Event('change',{bubbles:true}));});
 await act(async()=>{await sleep(70);});};
const plus=(n)=>{const d=new Date();d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};

console.log('\n=== Pairings belong to the day they were built for ===\n');

// the reported scenario: new players, date moved on, last week's pairings still there
{
  const {c,act,store}=await boot({'player-directory':JSON.stringify(roster)});
  for(let i=0;i<8;i++) await toggle(c,act,i);
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(200);});
  check('a fresh sheet renders normally',text(c).includes('SET 1'),text(c).slice(0,250));

  await click(act,findButton(c,'Today'));
  for(let i=0;i<8;i++) await toggle(c,act,i);
  for(let i=6;i<16;i++) await toggle(c,act,i);
  await setDate(c,act,plus(7));
  await click(act,findButton(c,'Results'));
  const t=text(c);
  check("last week's pairings are no longer shown as this session's",!/SET 1/.test(t),t.slice(0,300));
  check('it says there are none for this session',t.includes('No pairings for this session yet'),t.slice(0,400));
  check('it names the day they were actually built for',/were made for/.test(t),t.slice(0,500));
  check('it says how many are playing now',/pair the 10 people/.test(t),t.slice(0,600));
  check('and offers to generate',!!findButton(c,'Generate Pairings'));

  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(220);});
  check('generating produces this session’s sheet',text(c).includes('SET 1')&&!text(c).includes('No pairings for this session yet'),text(c).slice(0,300));
  const id=global.localStorage.getItem('court-call-device-id');
  const st=JSON.parse(store._docs.get(`${WK}:${id}`));
  check('the new sheet is stamped with this session',st.schedule.generatedFor===plus(7),String(st.schedule.generatedFor));
  const inSheet=new Set();
  st.schedule.rounds.forEach(r=>{r.matches.forEach(m=>[...m.teamA,...m.teamB].forEach(x=>inSheet.add(x)));(r.sittingOut||[]).forEach(x=>inSheet.add(x));});
  check('and holds exactly who is playing now',st.playingIds.every(x=>inSheet.has(x))&&[...inSheet].every(x=>st.playingIds.includes(x)),JSON.stringify([...inSheet]));
}

// same day, players changed -> still the drift warning, not the wrong-day one
{
  const {c,act}=await boot({'player-directory':JSON.stringify(roster)});
  for(let i=0;i<8;i++) await toggle(c,act,i);
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(200);});
  await click(act,findButton(c,'Today'));
  await toggle(c,act,9);
  await click(act,findButton(c,'Results'));
  const t=text(c);
  check('a same-day change still shows the pairings',/SET 1/.test(t),t.slice(0,250));
  check('and reports it as a mismatch, not a different day',t.includes("don't match who's playing")&&!t.includes('No pairings for this session yet'),t.slice(0,400));
}

// a sheet saved before pairings carried a date is taken at face value
{
  const legacy={playingIds:['p0','p1','p2','p3'],sessionDate:plus(0),sessionTime:'18:00',sessionDuration:'120',
    rounds:3,setFormats:['mixed','split','mixed'],
    schedule:{rounds:[{matches:[{format:'Doubles',courtNumber:1,teamA:['p0','p1'],teamB:['p2','p3']}],sittingOut:[]}],
      playerMap:Object.fromEntries(roster.map(p=>[p.id,p]))},   // no generatedFor
    updatedAt:Date.now()-3600e3};
  const id='legacydev';
  installDom(); global.localStorage.setItem('court-call-device-id',id);
  const store=makeStore({'player-directory':JSON.stringify(roster),[`${WK}:${id}`]:JSON.stringify(legacy)});
  global.window.storage=store;
  const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
  const m=await import(`${APP_URL}?t=${Math.random()}`);
  const c=global.document.getElementById('root');const root=createRoot(c);
  await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(110);});
  await click(act,findButton(c,'Results'));
  check('an unstamped sheet is not blanked on upgrade',text(c).includes('SET 1'),text(c).slice(0,300));
}

// watching a sheet that has rolled over
{
  const theirs={playingIds:['p6','p7','p8','p9'],sessionDate:plus(1),sessionTime:'18:00',sessionDuration:'120',
    rounds:3,setFormats:['mixed','split','mixed'],
    schedule:{generatedFor:plus(-6),rounds:[{matches:[{format:'Doubles',courtNumber:1,teamA:['p0','p1'],teamB:['p2','p3']}],sittingOut:[]}],
      playerMap:Object.fromEntries(roster.map(p=>[p.id,p]))},
    updatedAt:Date.now()-3600e3};
  const {c,act}=await boot({'player-directory':JSON.stringify(roster),[`${WK}:robb`]:JSON.stringify(theirs)});
  await click(act,findButton(c,'other session'));
  await click(act,findButton(c,'Watch'));
  await act(async()=>{await sleep(140);});
  const t=text(c);
  check('watching a rolled-over sheet explains it too',t.includes('No pairings for this session yet'),t.slice(0,500));
  check('it does not offer to generate on their behalf',!findButton(c,'Generate Pairings'),'');
  check('and says they may not have rebuilt it yet',/may not have been rebuilt/.test(t),t.slice(0,600));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
