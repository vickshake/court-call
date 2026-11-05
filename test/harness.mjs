import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { JSDOM } from 'jsdom';

// The bundle test/build.mjs writes, resolved relative to this file so the suite runs
// from anywhere in the repo.
export const APP_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '.app-under-test.mjs')).href;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const re=console.error; console.error=(...a)=>{const f=String(a[0]||'');if(f.includes('not configured to support act'))return;re(...a);};
export function installDom(){
 const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'https://court-call.web.app/',pretendToBeVisual:true});
 const {window}=dom; const def=(o,k,v)=>{try{Object.defineProperty(o,k,{value:v,configurable:true,writable:true});}catch{}};
 global.window=window; global.document=window.document; def(global,'navigator',window.navigator);
 global.HTMLElement=window.HTMLElement; global.Element=window.Element; global.Node=window.Node;
 global.Event=window.Event; global.MouseEvent=window.MouseEvent;
 global.getComputedStyle=window.getComputedStyle.bind(window);
 global.requestAnimationFrame=(cb)=>setTimeout(()=>cb(Date.now()),0); global.cancelAnimationFrame=(i)=>clearTimeout(i);
 def(window,'crypto',globalThis.crypto); def(global,'crypto',globalThis.crypto);
 const m=new Map();const ls={getItem:(k)=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:(k)=>m.delete(k),clear:()=>m.clear()};
 def(global,'localStorage',ls);def(window,'localStorage',ls);
 const noNet=async()=>{throw new Error('no net');}; def(global,'fetch',noNet); def(window,'fetch',noNet);
 global.__BUILD_VERSION__='test'; window.__CC_STANDALONE__=true; return dom;}
export function makeStore(seed={}){const docs=new Map(Object.entries(seed));const state={blocked:false,writes:[],reads:[],deletes:[]};
 return {async get(k){state.reads.push(k);if(state.blocked){const e=new Error('u');e.storageErrorType='unavailable';throw e;}
  if(!docs.has(k)){const e=new Error('nf');e.storageErrorType='not-found';throw e;} return{key:k,value:docs.get(k)};},
  async set(k,v){state.writes.push(k);docs.set(k,v);return{key:k,value:v};},
  async delete(k){docs.delete(k);return{key:k,deleted:true};},
  async list(p){return{keys:[...docs.keys()].filter(k=>!p||k.startsWith(p))};},
  _docs:docs,_state:state};}
export const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
export function text(c){return (c.textContent||'').replace(/\s+/g,' ');}
export function findButton(c,l){return [...c.querySelectorAll('button')].find(b=>(b.textContent||'').replace(/\s+/g,' ').trim().includes(l));}
