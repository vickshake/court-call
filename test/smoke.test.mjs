import { APP_URL, installDom, makeStore, sleep, text, findButton } from './harness.mjs';
let pass=0,fail=0;
const check=(n,c,d)=>{if(c){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(d?' :: '+d:''));}};
async function seedReg(){const enc=new TextEncoder();const mk=async(p)=>{const sa=new Uint8Array(16);globalThis.crypto.getRandomValues(sa);
 const salt=[...sa].map(b=>b.toString(16).padStart(2,'0')).join('');
 const b=await globalThis.crypto.subtle.digest('SHA-256',enc.encode(salt+':'+p));
 return{hash:[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''),salt};};
 return JSON.stringify({superuserPin:await mk('9876'),admins:[{id:'a1',playerId:'p1',name:'Vick',pin:await mk('4321')}]});}
const roster=[
 {id:'p1',name:'Adam McDonald',sex:'M',cta:4.0,usta:4.0,serving:4,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null},
 {id:'p2',name:'Andrea Gruner',sex:'F',cta:3.5,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null},
 {id:'p3',name:'Brett Powell',sex:'M',cta:3.5,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null},
 {id:'p4',name:'Charity Secord',sex:'F',cta:3.0,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null}];
const hist=[];
for(let k=0;k<6;k++) hist.push({id:`h${k}`,date:`2026-09-0${k+1}`,setNumber:1,court:'1',format:'Doubles',
 teamA:['p4','p3'],teamB:['p1','p2'],teamANames:['Charity Secord','Brett Powell'],teamBNames:['Adam McDonald','Andrea Gruner'],winner:'A'});
async function mount(){installDom();
 const store=makeStore({'player-directory':JSON.stringify(roster),'admin-registry':await seedReg(),'match-history':JSON.stringify(hist)});
 global.window.storage=store;
 const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
 const m=await import(`${APP_URL}?t=${Math.random()}`);
 const c=global.document.getElementById('root');const root=createRoot(c);
 await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(70);});return{c,act,root,store};}
const click=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});await act(async()=>{await sleep(30);});};
async function unlock(c,act){await click(act,findButton(c,'Directory'));
 const pw=c.querySelector('input[type="password"]');
 await act(async()=>{Object.getOwnPropertyDescriptor(global.window.HTMLInputElement.prototype,'value').set.call(pw,'4321');pw.dispatchEvent(new global.Event('input',{bubbles:true}));});
 await act(async()=>{await sleep(10);});await click(act,findButton(c,'Unlock'));}

console.log('\n=== Core regression ===\n');
{
  const {c,act,root,store}=await mount();
  check('no rating beside names',!/4\.0 CTA|3\.5 CTA/.test(text(c)),text(c).slice(0,250));
  for(const n of ['Adam McDonald','Andrea Gruner','Brett Powell','Charity Secord']){
    const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(n));await click(act,r);}
  check('four marked in',text(c).includes('Playing today (4)'),text(c).slice(0,250));
  check('the next-step hint appears',text(c).includes('choose your sets'),text(c).slice(0,350));
  const info=[...c.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').startsWith('Details for'));
  await click(act,info);
  check('the player card opens',text(c).includes('Pairing uses the CTA rating'),text(c).slice(0,300));
  const close=[...c.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'')==='Close');
  await click(act,close);
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(150);});
  check('pairings generate',text(c).includes('SET 1'),text(c).slice(0,250));
  check('the streak flame carries its count',/🔥\d/.test(text(c)),text(c).match(/🔥\d?/g)?.join(',')||'none');
  const win=[...c.querySelectorAll('button')].find(x=>(x.className||'').includes('tp-winbtn'));
  if(win) await click(act,win);
  check('a result is logged',store._docs.has('match-history'));
  await click(act,findButton(c,'History'));
  check('no standings table',!text(c).includes('Win / loss record'),text(c).slice(0,300));
  check('the match log remains',text(c).includes('Logged matches'),text(c).slice(0,300));
  const id=global.localStorage.getItem('court-call-device-id');
  await act(async()=>{root.unmount();});await act(async()=>{await sleep(50);});
  check('telemetry records',store._docs.has(`usage-telemetry:${id}`));
}
{
  const {c,act}=await mount();
  await unlock(c,act);
  check('insights are offered to admins',text(c).includes('Show insights'),text(c).slice(0,400));
  await click(act,findButton(c,'Show insights'));
  check('the insights panel opens',text(c).includes('Does the rating match the result'),text(c).slice(0,500));
  check('win percentages are shown',/\d+%/.test(text(c)),text(c).match(/\d+%/g)?.slice(0,2).join(',')||'none');
  // The guide sits with the dropdowns it explains, in the edit form - not on the list.
  const pencil=[...c.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').startsWith('Edit '));
  await click(act,pencil);
  check('the rating guide is reachable from the edit form',!!findButton(c,'What do these ratings mean?'),text(c).slice(0,400));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
