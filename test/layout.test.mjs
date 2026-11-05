import { APP_URL, installDom, makeStore, sleep, text, findButton } from './harness.mjs';
let pass=0,fail=0;
const check=(n,c,d)=>{if(c){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(d?' :: '+d:''));}};
const roster=[];
for(let i=0;i<4;i++) roster.push({id:`p${i}`,name:`Player ${i}`,sex:i%2?'F':'M',cta:3.5,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null});
async function boot(){installDom();
 const store=makeStore({'player-directory':JSON.stringify(roster)}); global.window.storage=store;
 const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
 const m=await import(`${APP_URL}?t=${Math.random()}`);
 const c=global.document.getElementById('root');const root=createRoot(c);
 await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(70);});return{c,act,store};}
const click=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});await act(async()=>{await sleep(30);});};

console.log('\n=== Portrait layout ===\n');
{
  const {c,act}=await boot();
  const css=[...c.querySelectorAll('style')].map(s=>s.textContent).join('\n');

  check('the app root contains horizontal overflow',/\.tp-root \{ overflow-x: hidden; max-width: 100%; \}/.test(css),'');
  check('children can shrink below their content width',/\.tp-root \* \{ min-width: 0; \}/.test(css),'');

  // The session row: three controls that must be allowed to wrap on a phone.
  const dateInput=c.querySelector('input[type="date"]');
  const row=dateInput && dateInput.parentElement;
  check('the session row exists',!!row);
  check('it is allowed to wrap',!!row && (row.className||'').includes('flex-wrap'),row?row.className:'');

  const inlineOf=(el)=>el?(el.getAttribute('style')||''):'';
  check('the date can shrink',/min-width:\s*0/.test(inlineOf(dateInput)),inlineOf(dateInput));

  const timeSel=[...c.querySelectorAll('select')].find(s=>s.getAttribute('aria-label')==='Start time');
  const durSel=[...c.querySelectorAll('select')].find(s=>s.getAttribute('aria-label')==='How long');
  check('the time control is labelled and shrinkable',!!timeSel&&/min-width:\s*0/.test(inlineOf(timeSel)),inlineOf(timeSel));
  check('the duration control is labelled and shrinkable',!!durSel&&/min-width:\s*0/.test(inlineOf(durSel)),inlineOf(durSel));

  // the placeholder was the widest text in that row
  check('the duration placeholder is short',
    !!durSel && [...durSel.options].some(o=>o.textContent==='How long?') && ![...durSel.options].some(o=>o.textContent==='For how long?'),
    durSel?[...durSel.options].slice(0,2).map(o=>o.textContent).join('|'):'');

  // no element declares a fixed width that would exceed a narrow phone
  const wide=[...c.querySelectorAll('*')].filter(el=>{
    const st=el.getAttribute('style')||'';
    const m=st.match(/(?:^|[^-])width:\s*(\d+)px/);
    return m && Number(m[1])>320;
  });
  check('nothing declares a fixed width wider than a small phone',wide.length===0,
    wide.slice(0,2).map(e=>e.getAttribute('style')).join(' | '));
}
// the rest of the app still works after the layout change
{
  const {c,act,store}=await boot();
  for(const p of roster){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(p.name));await click(act,r);}
  check('players can still be marked in',text(c).includes('Playing today (4)'),text(c).slice(0,250));
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(150);});
  check('pairings still generate',text(c).includes('SET 1'),text(c).slice(0,250));
  const id=global.localStorage.getItem('court-call-device-id');
  check('the week is still saved',store._docs.has(`weekly-state-v2:${id}`));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
