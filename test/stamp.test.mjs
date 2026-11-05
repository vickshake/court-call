import { APP_URL, installDom, makeStore, sleep, text, findButton } from './harness.mjs';
let pass=0,fail=0;
const check=(n,c,d)=>{if(c){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(d?' :: '+d:''));}};
const WK='weekly-state-v2';
const today=(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})();
const earlier='2026-11-01';
const roster=[];
for(let i=0;i<20;i++) roster.push({id:`p${i}`,name:`Player ${i}`,sex:i%2?'F':'M',cta:3.5,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null});
const pm=Object.fromEntries(roster.map(p=>[p.id,p]));

// The reported sheet: 16 marked in, pairings hold exactly those 16, stamped an earlier day.
function stampedOtherDay(){
  const ids=Array.from({length:16},(_,i)=>'p'+i);
  const matches=[];
  for(let k=0;k<16;k+=4) matches.push({format:'Mixed Doubles',courtNumber:(k/4)+1,teamA:[ids[k],ids[k+1]],teamB:[ids[k+2],ids[k+3]]});
  return {playingIds:ids, sessionDate:today, sessionTime:'18:00', sessionDuration:'120',
    rounds:3, setFormats:['mixed','split','mixed'],
    schedule:{generatedFor:earlier, rounds:[{matches,sittingOut:[]}], playerMap:pm},
    updatedAt:Date.now()-3*3600e3};
}
// A genuinely carried-over sheet: different people entirely.
function trulyStale(){
  const s=stampedOtherDay();
  s.playingIds=Array.from({length:10},(_,i)=>'p'+(i+10));
  return s;
}
async function bootAs(devId,seed){
  installDom(); global.localStorage.setItem('court-call-device-id',devId);
  const store=makeStore(seed); global.window.storage=store;
  const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
  const m=await import(`${APP_URL}?t=${Math.random()}`);
  const c=global.document.getElementById('root');const root=createRoot(c);
  await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(120);});
  return {c,act,store};
}
const click=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});await act(async()=>{await sleep(55);});};

console.log('\n=== A sheet stamped with an earlier day ===\n');

// THE REPORTED CASE, on your own sheet
{
  const {c,act}=await bootAs('mine',{'player-directory':JSON.stringify(roster),[`${WK}:mine`]:JSON.stringify(stampedOtherDay())});
  await click(act,findButton(c,'Results'));
  const t=text(c);
  check('the pairings are shown, not hidden',/SET 1/.test(t)&&/COURT 1/.test(t),t.slice(0,300));
  check('it is not called a different session',!t.includes('No pairings for this session yet'),t.slice(0,300));
  check('the older stamp is mentioned',/were generated for/.test(t),t.slice(0,500));
  check('and names the day',/November 1|Nov 1/.test(t),t.slice(0,500));
  check('with a re-roll offered rather than forced',/Re-roll below/.test(t)&&!!findButton(c,'Re-roll pairings'),t.slice(0,600));
  check('no false claim that the group differs',!/different group/.test(t),t.slice(0,500));
}

// WATCHING that same sheet - the exact screenshot scenario
{
  const {c,act}=await bootAs('mine2',{'player-directory':JSON.stringify(roster),[`${WK}:robb`]:JSON.stringify(stampedOtherDay())});
  await click(act,findButton(c,'other session'));
  await click(act,findButton(c,'Watch'));
  await act(async()=>{await sleep(160);});
  const t=text(c);
  check("the organizer's pairings now appear when watching",/SET 1/.test(t)&&/COURT 1/.test(t),t.slice(0,400));
  check('the empty state is gone',!t.includes('No pairings for this session yet'),t.slice(0,400));
  check('the watch banner is still there',t.includes("Watching another browser's sheet"),t.slice(0,300));
  check('the stamp note appears without offering to re-roll theirs',/were generated for/.test(t)&&!/Re-roll below/.test(t),t.slice(0,600));
  check('winners can still be marked',[...c.querySelectorAll('button')].some(b=>(b.className||'').includes('tp-winbtn')),'');
}

// A genuinely carried-over sheet must STILL be caught
{
  const {c,act}=await bootAs('mine3',{'player-directory':JSON.stringify(roster),[`${WK}:mine3`]:JSON.stringify(trulyStale())});
  await click(act,findButton(c,'Results'));
  const t=text(c);
  check("a real carry-over is still hidden",!/COURT 1/.test(t),t.slice(0,300));
  check('and explained',t.includes('No pairings for this session yet'),t.slice(0,300));
  check('naming how many are actually marked in',/different group than the 10 marked in/.test(t),t.slice(0,500));
  check('and the day it was built for',/November 1|Nov 1/.test(t),t.slice(0,500));
  check('with a way forward',!!findButton(c,'Generate Pairings'));
}

// Regenerating restamps, and the note goes
{
  const {c,act,store}=await bootAs('mine4',{'player-directory':JSON.stringify(roster),[`${WK}:mine4`]:JSON.stringify(stampedOtherDay())});
  await click(act,findButton(c,'Results'));
  await click(act,findButton(c,'Re-roll pairings'));
  await act(async()=>{await sleep(260);});
  const t=text(c);
  check('re-rolling clears the stamp note',!/were generated for/.test(t),t.slice(0,400));
  check('and the sheet still renders',/SET 1/.test(t),t.slice(0,300));
  const st=JSON.parse(store._docs.get(`${WK}:mine4`));
  check('the new sheet carries today’s stamp',st.schedule.generatedFor===today,String(st.schedule.generatedFor));
}

// A matching, correctly stamped sheet says nothing extra
{
  const good=stampedOtherDay(); good.schedule.generatedFor=today;
  const {c,act}=await bootAs('mine5',{'player-directory':JSON.stringify(roster),[`${WK}:mine5`]:JSON.stringify(good)});
  await click(act,findButton(c,'Results'));
  const t=text(c);
  check('a correctly stamped sheet is quiet',!/were generated for/.test(t)&&!/No pairings for this session/.test(t),t.slice(0,400));
  check('and renders normally',/SET 1/.test(t),t.slice(0,250));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
