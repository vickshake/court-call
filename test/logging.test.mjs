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
 await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(90);});return{c,act,store};}
const click=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});await act(async()=>{await sleep(45);});};

// Robb's sheet, dated two days before whatever today is
const theirDate='2026-10-05';
async function makeRobb(){
  const {c,act,store}=await boot({'player-directory':JSON.stringify(roster)});
  for(let i=0;i<8;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(200);});
  const id=global.localStorage.getItem('court-call-device-id');
  const st=JSON.parse(store._docs.get(`${WK}:${id}`));
  st.sessionDate=theirDate;                 // their session, not ours
  st.schedule.generatedFor=theirDate;       // built for that session, as a real sheet would be
  st.updatedAt=Date.now()-3600e3;
  return JSON.stringify(st);
}
const robbDoc=await makeRobb();

console.log('\n=== Logging from a watched sheet ===\n');
{
  const {c,act,store}=await boot({'player-directory':JSON.stringify(roster),[`${WK}:robb`]:robbDoc});
  await click(act,findButton(c,'other session'));
  await click(act,findButton(c,'Watch'));
  await act(async()=>{await sleep(140);});
  const win=[...c.querySelectorAll('button')].find(x=>(x.className||'').includes('tp-winbtn'));
  await click(act,win);
  await act(async()=>{await sleep(100);});
  const h=JSON.parse(store._docs.get('match-history')||'[]');
  check('the result is written',h.length===1,String(h.length));
  check('it is filed under their session date, not ours',h[0]&&h[0].date===theirDate,h[0]?h[0].date:'none');
  check('it carries real player names, not placeholders',h[0]&&h[0].teamANames.every(n=>n!=='?'),JSON.stringify(h[0]?h[0].teamANames:[]));
  check('a winner is recorded',!!(h[0]&&h[0].winner),String(h[0]&&h[0].winner));

  // and it reads back as logged on that same sheet
  check('the sheet shows it as logged',[...c.querySelectorAll('button')].some(b=>b.getAttribute('data-won')==='true'),'');
  // tapping again clears it, as on your own sheet
  const won=[...c.querySelectorAll('button')].find(b=>b.getAttribute('data-won')==='true');
  await click(act,won);
  await act(async()=>{await sleep(90);});
  const h2=JSON.parse(store._docs.get('match-history')||'[]');
  check('tapping the same pair again clears the result',h2.length===0||!h2[0].winner,JSON.stringify(h2).slice(0,120));
}

// logging on your own sheet still files under your own date
{
  const {c,act,store}=await boot({'player-directory':JSON.stringify(roster)});
  for(let i=0;i<4;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(200);});
  const win=[...c.querySelectorAll('button')].find(x=>(x.className||'').includes('tp-winbtn'));
  await click(act,win);
  await act(async()=>{await sleep(90);});
  const h=JSON.parse(store._docs.get('match-history')||'[]');
  const today=(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})();
  check('your own results still file under today',h[0]&&h[0].date===today,h[0]?h[0].date:'none');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
