import { APP_URL, installDom, makeStore, sleep, text, findButton } from './harness.mjs';
let pass=0,fail=0;
const check=(n,c,d)=>{if(c){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(d?' :: '+d:''));}};
const roster=[];
for(let i=0;i<10;i++) roster.push({id:`p${i}`,name:`Player ${i}`,sex:i%2?'F':'M',cta:3.5,usta:null,serving:3,competitive:3,active:true,injuries:'',comments:'',handedness:'R',preferredCourt:null});

// A fake 2d context that records what was asked of it, so the drawing can be checked
// without a real canvas.
function stubCanvas(){
  const ops=[];
  const ctx={ ops, _font:'',
    set font(v){ this._font=v; ops.push(['font',v]); }, get font(){ return this._font; },
    fillStyle:'', strokeStyle:'', lineWidth:1,
    scale:(a,b)=>ops.push(['scale',a,b]),
    fillRect:(...a)=>ops.push(['fillRect',...a]),
    strokeRect:(...a)=>ops.push(['strokeRect',...a]),
    fillText:(t,x,y)=>ops.push(['fillText',t,x,y]),
    measureText:(t)=>({width:t.length*14}),
  };
  const canvas={width:0,height:0,getContext:()=>ctx,toDataURL:()=>'data:image/png;base64,aGk='};
  return {canvas,ctx,ops};
}

async function boot(opts={}){
  installDom();
  const store=makeStore({'player-directory':JSON.stringify(roster)}); global.window.storage=store;
  const stub=stubCanvas();
  const realCreate=global.document.createElement.bind(global.document);
  global.document.createElement=(tag)=>tag==='canvas'?stub.canvas:realCreate(tag);
  if(opts.share) Object.defineProperty(global.navigator,'share',{value:opts.share,configurable:true});
  if(opts.canShare) Object.defineProperty(global.navigator,'canShare',{value:opts.canShare,configurable:true});
  global.window.File=global.File=class File{constructor(b,n,o){this.name=n;this.type=(o||{}).type;this.size=(b[0]||'').length||1;}};
  global.atob=(b)=>Buffer.from(b,'base64').toString('binary');
  const React=(await import('react')).default;const{act}=await import('react');const{createRoot}=await import('react-dom/client');
  const m=await import(`${APP_URL}?t=${Math.random()}`);
  const c=global.document.getElementById('root');const root=createRoot(c);
  await act(async()=>{root.render(React.createElement(m.default));});await act(async()=>{await sleep(90);});
  return {c,act,store,stub};
}
const click=async(act,el)=>{await act(async()=>{el.dispatchEvent(new global.MouseEvent('click',{bubbles:true}));});await act(async()=>{await sleep(60);});};
async function makeSheet(c,act){
  for(let i=0;i<8;i++){const r=[...c.querySelectorAll('button')].find(x=>(x.textContent||'').includes(`Player ${i}`));await click(act,r);}
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(200);});
}

console.log('\n=== Sharing the sheet as a picture ===\n');

// the happy path: a phone with a share sheet
{
  const shared=[];
  const {c,act,stub}=await boot({share:async(d)=>{shared.push(d);},canShare:(d)=>!!(d&&d.files)});
  await makeSheet(c,act);
  const btn=findButton(c,'Share the sheet');
  check('the share button is offered first',!!btn,text(c).slice(0,300));
  check('copying as text is still there',!!findButton(c,'Copy as text'));
  await click(act,btn);
  await act(async()=>{await sleep(120);});
  check('the native share sheet is opened',shared.length===1,String(shared.length));
  check('with an image file attached',!!(shared[0]&&shared[0].files&&shared[0].files[0]),JSON.stringify(Object.keys(shared[0]||{})));
  check('named so it is recognisable in a chat',shared[0].files[0].name==='court-call.png',String(shared[0]&&shared[0].files[0].name));
  check('as a PNG',shared[0].files[0].type==='image/png',String(shared[0]&&shared[0].files[0].type));

  const t=stub.ops.filter(o=>o[0]==='fillText').map(o=>o[1]);
  check('the picture carries the wordmark',t.includes('COURT ')&&t.includes('CALL'),t.slice(0,4).join('|'));
  check('every set is drawn',['SET 1','SET 2','SET 3'].every(x=>t.includes(x)),t.filter(x=>/^SET/.test(x)).join(','));
  check('courts are labelled with their real number',t.some(x=>/^COURT \d · /.test(x)),t.find(x=>/^COURT/.test(x))||'none');
  check('player names appear',t.some(x=>/Player \d/.test(x)),t.find(x=>/Player/.test(x))||'none');
  check('and the app is credited so people can find it',t.includes('court-call.web.app'),'');
}

// a browser with no share sheet falls back to saving
{
  const {c,act}=await boot({});   // no navigator.share
  await makeSheet(c,act);
  await click(act,findButton(c,'Share the sheet'));
  await act(async()=>{await sleep(120);});
  const t=text(c);
  check('it saves the image instead',/Saved to your photos/.test(t),t.slice(0,300));
  check('and explains what to do with it',/attach it/.test(t),t.slice(0,400));
}

// dismissing the share sheet is not an error
{
  const {c,act}=await boot({share:async()=>{const e=new Error('x');e.name='AbortError';throw e;},canShare:()=>true});
  await makeSheet(c,act);
  await click(act,findButton(c,'Share the sheet'));
  await act(async()=>{await sleep(120);});
  check('backing out of the share sheet says nothing',!/Couldn't|Saved/.test(text(c)),text(c).slice(0,300));
  check('and the button returns to normal',!!findButton(c,'Share the sheet'),'');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
