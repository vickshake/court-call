import { APP_URL, installDom, makeStore, sleep, text, findButton } from './harness.mjs';
let pass=0,fail=0;
const check=(n,c,d)=>{if(c){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(d?' :: '+d:''));}};
const WK='weekly-state-v2';
const today=(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})();
const roster=[];
for(let i=0;i<20;i++) roster.push({id:`p${i}`,name:`Player ${i}`,sex:i%2?'F':'M',cta:3.5,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null});
const pm=Object.fromEntries(roster.map(p=>[p.id,p]));

// An UNSTAMPED sheet, exactly as one saved before v0.77.0 looks:
// this week's 10 marked in, last week's pairings still sitting there.
function legacySheet(){
  return {playingIds:['p10','p11','p12','p13','p14','p15','p16','p17','p18','p19'],
    sessionDate:today, sessionTime:'10:30', sessionDuration:'120',
    rounds:3, setFormats:['mixed','split','mixed'],
    schedule:{ /* no generatedFor */
      rounds:[{matches:[{format:'Mixed Doubles',courtNumber:1,teamA:['p0','p1'],teamB:['p2','p3']}],sittingOut:[]}],
      playerMap:pm},
    updatedAt:Date.now()-3600e3};
}
// An unstamped sheet that DOES still describe who's marked in - must not be disturbed.
function legacyConsistent(){
  return {playingIds:['p0','p1','p2','p3'], sessionDate:today, sessionTime:'10:30', sessionDuration:'120',
    rounds:3, setFormats:['mixed','split','mixed'],
    schedule:{rounds:[{matches:[{format:'Mixed Doubles',courtNumber:1,teamA:['p0','p1'],teamB:['p2','p3']}],sittingOut:[]}],playerMap:pm},
    updatedAt:Date.now()-3600e3};
}
async function bootAs(devId,seed){
  installDom(); global.localStorage.setItem('court-call-device-id',devId);
  const store=makeStore(seed); global.window.storage=store;
  const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
  const m=await import(`${APP_URL}?t=${Math.random()}`);
  const c=global.document.getElementById('root');const root=createRoot(c);
  await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(110);});
  return {c,act,store};
}
const click=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});await act(async()=>{await sleep(50);});};

console.log('\n=== Sheets saved before pairings carried a date ===\n');

// the reported case, on your own sheet
{
  const {c,act}=await bootAs('mine',{'player-directory':JSON.stringify(roster),[`${WK}:mine`]:JSON.stringify(legacySheet())});
  check('the ten marked in are listed',text(c).includes('Playing today (10)'),text(c).slice(0,300));
  await click(act,findButton(c,'Results'));
  const t=text(c);
  check("last week's players are no longer rendered",!/COURT 1|SET 1/.test(t),t.slice(0,400));
  check('it says there are none for this session',t.includes('No pairings for this session yet'),t.slice(0,400));
  check('with no date to name, it says so plainly',/made for an earlier session/.test(t),t.slice(0,500));
  check('and offers to generate for the ten',/pair the 10 people/.test(t),t.slice(0,600));
}

// an unstamped sheet that still matches must be left alone
{
  const {c,act}=await bootAs('ok',{'player-directory':JSON.stringify(roster),[`${WK}:ok`]:JSON.stringify(legacyConsistent())});
  await click(act,findButton(c,'Results'));
  const t=text(c);
  check('a still-accurate unstamped sheet keeps rendering',/COURT 1/.test(t),t.slice(0,400));
  check('and is not called a different session',!t.includes('No pairings for this session yet'),t.slice(0,300));
}

// watching somebody else's unstamped, carried-over sheet
{
  const {c,act}=await bootAs('mine2',{'player-directory':JSON.stringify(roster),[`${WK}:robb`]:JSON.stringify(legacySheet())});
  await click(act,findButton(c,'other session'));
  check('their sheet is listed',!!findButton(c,'Watch'),text(c).slice(0,400));
  await click(act,findButton(c,'Watch'));
  await act(async()=>{await sleep(150);});
  const t=text(c);
  check('the watch banner shows',t.includes("Watching another browser's sheet"),t.slice(0,400));
  check('their carried-over pairings are not shown as current',!/COURT 1/.test(t),t.slice(0,500));
  check('it explains why',t.includes('No pairings for this session yet'),t.slice(0,500));
  check('and that only they can rebuild it',/may not have been rebuilt/.test(t),t.slice(0,600));
  check('it does not offer to generate on their behalf',!findButton(c,'Generate Pairings'),'');
}

// generating clears it and stamps the new sheet
{
  const {c,act,store}=await bootAs('mine3',{'player-directory':JSON.stringify(roster),[`${WK}:mine3`]:JSON.stringify(legacySheet())});
  await click(act,findButton(c,'Results'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(240);});
  const t=text(c);
  check('generating produces this session’s sheet',/SET 1/.test(t)&&!t.includes('No pairings for this session yet'),t.slice(0,300));
  const st=JSON.parse(store._docs.get(`${WK}:mine3`));
  check('and it is stamped from now on',st.schedule.generatedFor===today,String(st.schedule.generatedFor));
  const inSheet=new Set();
  st.schedule.rounds.forEach(r=>{r.matches.forEach(m=>[...m.teamA,...m.teamB].forEach(x=>inSheet.add(x)));(r.sittingOut||[]).forEach(x=>inSheet.add(x));});
  check('holding exactly the ten playing',st.playingIds.every(x=>inSheet.has(x))&&[...inSheet].every(x=>st.playingIds.includes(x)),JSON.stringify([...inSheet]));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
