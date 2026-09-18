const fs = require('node:fs')
const ts = require('typescript')
// Node 下加载真实 TS/TSX 源码，避免测试误读历史编译产物；类型检查由 tsc 独立执行。
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, file)
const { makeTrackItem } = require('@radio/contracts')
exports.item = id => makeTrackItem({ id, name: `曲${id}`, artists: '歌手', durationMs: 200000 })
exports.flush = async () => { for (let i=0;i<20;i++) await new Promise(r=>setImmediate(r)) }
exports.deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r}); return {promise,resolve} }
exports.setup = (t, ids=[101,102], overrides={}) => {
 const listeners = new Map()
 const audio = { paused:true,currentTime:0,duration:200,readyState:4,src:'',currentSrc:'',error:null,
 addEventListener(n,f){if(!listeners.has(n))listeners.set(n,new Set());listeners.get(n).add(f)},removeEventListener(n,f){listeners.get(n)?.delete(f)},
 removeAttribute(){this.src='';this.currentSrc=''},play(){this.paused=false;return Promise.resolve()},pause(){this.paused=true},
 emit(n){if(n==='playing')this.currentSrc=this.src;if(n==='ended')this.paused=true;for(const f of listeners.get(n)||[])f()} }
 const {api}=require('../../src/api/client.ts')
 const saved={...api}, savedDocument=global.document
 const records=[]; let session=1
 Object.assign(api,{
 resolve:async id=>({ok:true,playable:true,audioUrl:'/api/audio/'+id}),
 sessionStart:async()=>({ok:true,session:{id:'s'+session,adjustments:{}}}),
 sessionStop:async()=>{session++;return{ok:true}},
 session:async()=>({ok:true,session:{id:'s'+session,adjustments:{}}}),
 settings:async()=>({ok:true,settings:{djEnabled:'false'}}),feedback:async()=>({ok:true,active:[]}),
 playStart:async data=>{const row={id:records.length+1,...data,outcome:null};records.push(row);return{ok:true,playId:row.id,session:{id:'s'+session}}},
 playEnd:async(id,outcome)=>{records.find(r=>r.id===id).outcome=outcome;return{ok:true}},
 refill:async()=>({ok:true,picks:[{id:999,name:'补入曲',artists:'歌手'}]}),...overrides})
 global.document={getElementById:()=>audio}
 const file=require.resolve('../../src/app/radio-context.tsx');delete require.cache[file]
 const runtime=require(file).getRadioInstance()
 runtime.segue.setConfig({djEnabled:false})
 runtime.playback.replaceQueue(ids.map(exports.item))
 t.after(()=>{runtime.dispose?.();runtime.playback.dispose();runtime.refill.cancel();Object.assign(api,saved);global.document=savedDocument})
 return {runtime,audio,records,api}
}
