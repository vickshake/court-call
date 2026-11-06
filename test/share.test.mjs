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
  const seed={'player-directory':JSON.stringify(roster)};
  // A saved week with its session window, for the forecast cases
  if(opts.week){ global.localStorage.setItem('court-call-device-id','dev1'); seed['weekly-state-v2:dev1']=JSON.stringify(opts.week); }
  Object.assign(seed,opts.extra||{});
  const store=makeStore(seed); global.window.storage=store;
  if(opts.fetch){ global.fetch=opts.fetch; global.window.fetch=opts.fetch; }
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

console.log('\n=== The forecast on the picture ===\n');

const today=(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})();
// An Open-Meteo day: a warm, wet, windy afternoon, then a mild evening - so a line built
// from the wrong hours is obvious.
function forecastDay(date=today){
  const time=[],temp=[],rain=[],wind=[],gust=[],uv=[];
  for(let h=0;h<24;h++){
    time.push(`${date}T${String(h).padStart(2,'0')}:00`);
    const evening=h>=18;
    temp.push(evening?(h===18?55:h===19?53:50):70);
    rain.push(evening?(h===18?5:10):80);
    wind.push(evening?(h===18?7:9):25);
    gust.push(evening?(h===18?12:14):40);
    uv.push(evening?0:6);
  }
  return {
    hourly:{time,temperature_2m:temp,precipitation_probability:rain,wind_speed_10m:wind,wind_gusts_10m:gust,uv_index:uv},
    daily:{temperature_2m_max:[62],temperature_2m_min:[50],precipitation_probability_max:[20],wind_speed_10m_max:[15],wind_gusts_10m_max:[30],uv_index_max:[4]},
  };
}
const week=(time,duration)=>({playingIds:['p0','p1','p2','p3','p4','p5','p6','p7'],sessionDate:today,sessionTime:time,sessionDuration:duration,rounds:3,setFormats:['mixed','split','mixed'],schedule:null});
async function shareWithForecast(opts){
  const shared=[];
  const calls=[];
  const fetchFn=opts.fetch||(async(url)=>{calls.push(url);return{json:async()=>forecastDay()};});
  const {c,act,stub}=await boot({share:async(d)=>{shared.push(d);},canShare:()=>true,week:opts.week,fetch:fetchFn});
  await click(act,findButton(c,'Courts'));
  await click(act,findButton(c,'Generate Pairings'));
  await act(async()=>{await sleep(200);});
  await click(act,findButton(c,'Share the sheet'));
  await act(async()=>{await sleep(150);});
  return {shared,calls,lines:stub.ops.filter(o=>o[0]==='fillText').map(o=>o[1])};
}

// The 6 PM case: the hours being played, not the day
{
  const {shared,calls,lines}=await shareWithForecast({week:week('18:00','120')});
  const f=lines.find(x=>/^Forecast/.test(x));
  check('an evening sheet carries the forecast for 6-8 PM',f==='Forecast 6–8 PM: 54° · 10% rain · Wind 9 mph',String(f));
  check('the afternoon heat, rain and UV stay off it',!!f&&!/70°|80%|UV/.test(f),String(f));
  check('and it sits above the first set',lines.indexOf(f)>-1&&lines.indexOf(f)<lines.indexOf('SET 1'),lines.slice(0,5).join(' | '));
  check('the picture is still shared',shared.length===1,String(shared.length));
  check('one forecast request serves the homepage and the picture',calls.length===1,String(calls.length));
}

// A start time with no length: just that hour
{
  const {lines}=await shareWithForecast({week:week('18:00','')});
  const f=lines.find(x=>/^Forecast/.test(x));
  check('with no session length, the start hour alone',f==='Forecast 6 PM: 55° · 5% rain · Wind 7 mph',String(f));
}

// A midday window: UV earns its place, and so do strong gusts
{
  const {lines}=await shareWithForecast({week:week('12:00','60')});
  const f=lines.find(x=>/^Forecast/.test(x));
  check('a midday sheet shows UV and gusts',f==='Forecast 12–1 PM: 70° · 80% rain · Wind 25 mph, gusts 40 · UV 6',String(f));
}

// No start time: the day, and says so
{
  const {lines}=await shareWithForecast({week:week('','')});
  const f=lines.find(x=>/^Forecast/.test(x));
  check('with no start time, the whole day, labelled as such',f==='Forecast for the day: High 62° / low 50° · 20% rain · Wind 15 mph, gusts 30 · UV 4',String(f));
}

// Too far ahead to forecast: Open-Meteo answers with an error body
{
  const {shared,lines}=await shareWithForecast({week:week('18:00','120'),fetch:async()=>({json:async()=>({error:true,reason:'out of range'})})});
  check('beyond the forecast window, no line at all',!lines.some(x=>/^Forecast/.test(x)),lines.slice(0,4).join(' | '));
  check('and sharing is unaffected',shared.length===1,String(shared.length));
}

// Weather service unreachable
{
  const {shared,lines}=await shareWithForecast({week:week('18:00','120'),fetch:async()=>{throw new Error('offline');}});
  check('with no weather reachable, no line',!lines.some(x=>/^Forecast/.test(x)),lines.slice(0,4).join(' | '));
  check('and the picture still goes out',shared.length===1,String(shared.length));
}

// Watching someone else's sheet: the picture describes THEIR session
{
  // Make a real sheet, then file it as Robb's: tomorrow, 6 PM for two hours
  const tomorrow=(()=>{const d=new Date();d.setDate(d.getDate()+1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})();
  const made=await boot({week:week('',''),fetch:async()=>{throw new Error('offline');}});
  await click(made.act,findButton(made.c,'Courts'));
  await click(made.act,findButton(made.c,'Generate Pairings'));
  await made.act(async()=>{await sleep(200);});
  const robb=JSON.parse(made.store._docs.get('weekly-state-v2:dev1'));
  Object.assign(robb,{sessionDate:tomorrow,sessionTime:'18:00',sessionDuration:'120',updatedAt:Date.now()});

  // This browser's own week: today, no start time - a "for the day" line if it were used
  const dates=[];
  const shared=[];
  const {c,act,stub}=await boot({
    share:async(d)=>{shared.push(d);},canShare:()=>true,
    week:week('',''),
    extra:{'weekly-state-v2:robb':JSON.stringify(robb)},
    fetch:async(url)=>{const d=/start_date=([\d-]+)/.exec(url)[1];dates.push(d);return{json:async()=>forecastDay(d)};},
  });
  await click(act,findButton(c,'other session'));
  await click(act,findButton(c,'Watch'));
  await act(async()=>{await sleep(150);});
  await click(act,findButton(c,'Share the sheet'));
  await act(async()=>{await sleep(150);});
  const f=stub.ops.filter(o=>o[0]==='fillText').map(o=>o[1]).find(x=>/^Forecast/.test(x));
  check("while watching, the forecast is for their session's hours",f==='Forecast 6–8 PM: 54° · 10% rain · Wind 9 mph',String(f));
  check('and for their date',dates.includes(tomorrow),JSON.stringify(dates));
  check('the watched picture is shared',shared.length===1,String(shared.length));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
