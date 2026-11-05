import { APP_URL, installDom, makeStore, sleep, text, findButton } from './harness.mjs';
let pass=0,fail=0;
const check=(n,c,d)=>{if(c){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(d?' :: '+d:''));}};
const WK='weekly-state-v2';
function isoToday(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
const roster=[];
for(let i=0;i<8;i++) roster.push({id:`p${i}`,name:`Player ${i}`,sex:i%2?'F':'M',cta:3.5,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null});
async function boot(seed){installDom();
 const store=makeStore(seed); global.window.storage=store;
 const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
 const m=await import(`${APP_URL}?t=${Math.random()}`);
 const c=global.document.getElementById('root');const root=createRoot(c);
 await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(80);});return{c,act,store};}
const click=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});await act(async()=>{await sleep(40);});};
const toggle=async(c,act,i)=>{const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);};

console.log('\n=== Pairings that no longer match who is playing ===\n');

// a consistent sheet says nothing
{
  const {c,act}=await boot({'player-directory':JSON.stringify(roster)});
  for(let i=0;i<4;i++) await toggle(c,act,i);
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(160);});
  check('a fresh sheet raises no warning',!text(c).includes("don't match who's playing"),text(c).slice(0,300));
  await click(act,findButton(c,'Today'));
  check('and nothing on Today either',!text(c).includes('built for a different group'),text(c).slice(0,300));
}

// removing someone who is in the pairings
{
  const {c,act}=await boot({'player-directory':JSON.stringify(roster)});
  for(let i=0;i<4;i++) await toggle(c,act,i);
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(160);});
  await click(act,findButton(c,'Today'));
  await toggle(c,act,0);                       // Player 0 goes home
  check('Today flags it immediately',text(c).includes('built for a different group'),text(c).slice(0,400));
  check('and offers a way through',!!findButton(c,'Review →'));
  await click(act,findButton(c,'Review →'));
  const r=text(c);
  check('Results explains the mismatch',r.includes("don't match who's playing"),r.slice(0,400));
  check('it names who is on the sheet but not playing',/On the sheet but not playing:\s*Player 0/.test(r),r.slice(0,600));
  check('it warns regenerating discards adjustments',r.includes('discards any hand adjustments'),r.slice(0,700));
  check('it offers to regenerate',!!findButton(c,'Regenerate pairings'));
}

// adding someone the pairings never knew about
{
  const {c,act}=await boot({'player-directory':JSON.stringify(roster)});
  for(let i=0;i<4;i++) await toggle(c,act,i);
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(160);});
  await click(act,findButton(c,'Today'));
  await toggle(c,act,4); await toggle(c,act,5);  // two late arrivals
  await click(act,findButton(c,'Results'));
  const r=text(c);
  check('it names who is playing but absent from the sheet',/Playing but not on the sheet:/.test(r),r.slice(0,600));
  check('both late arrivals are named',/Player 4/.test(r)&&/Player 5/.test(r),r.slice(0,700));
}

// regenerating clears it
{
  const {c,act,store}=await boot({'player-directory':JSON.stringify(roster)});
  for(let i=0;i<4;i++) await toggle(c,act,i);
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(160);});
  await click(act,findButton(c,'Today'));
  await toggle(c,act,4); await toggle(c,act,5);
  await click(act,findButton(c,'Results'));
  await click(act,findButton(c,'Regenerate pairings'));
  await act(async()=>{await sleep(200);});
  check('regenerating clears the warning',!text(c).includes("don't match who's playing"),text(c).slice(0,400));
  const mine=global.localStorage.getItem('court-call-device-id');
  const st=JSON.parse(store._docs.get(`${WK}:${mine}`));
  const inSheet=new Set();
  st.schedule.rounds.forEach(r=>{r.matches.forEach(m=>[...m.teamA,...m.teamB].forEach(id=>inSheet.add(id)));(r.sittingOut||[]).forEach(id=>inSheet.add(id));});
  check('everyone playing is now in the sheet',st.playingIds.every(id=>inSheet.has(id)),JSON.stringify(st.playingIds)+' vs '+JSON.stringify([...inSheet]));
  check('nobody absent is left in it',[...inSheet].every(id=>st.playingIds.includes(id)),JSON.stringify([...inSheet]));
}

// a copied sheet that was already stale on the source browser
{
  const robb={playingIds:['p0','p1','p4','p5'],sessionDate:isoToday(),sessionTime:'18:00',sessionDuration:'120',
    rounds:3,setFormats:['mixed','split','mixed'],
    // generated before p4/p5 arrived and p2/p3 left
    schedule:{rounds:[{matches:[{format:'Doubles',courtNumber:1,teamA:['p0','p1'],teamB:['p2','p3']}],sittingOut:[]}],
      playerMap:Object.fromEntries(roster.map(p=>[p.id,p]))},
    updatedAt:Date.now()-3600e3};
  const {c,act}=await boot({'player-directory':JSON.stringify(roster),[`${WK}:robb`]:JSON.stringify(robb)});
  await click(act,findButton(c,'other session'));
  await click(act,findButton(c,'Copy'));
  await act(async()=>{await sleep(100);});
  // An unstamped sheet whose players no longer match is a previous session's, not a
  // mismatch to review - Results says so rather than Today.
  await click(act,findButton(c,'Results'));
  const rt=text(c);
  check('a copy of an already-stale sheet is flagged',rt.includes('No pairings for this session yet'),rt.slice(0,400));
  check("and its pairings are not shown as this session's",!/COURT 1/.test(rt),rt.slice(0,400));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
