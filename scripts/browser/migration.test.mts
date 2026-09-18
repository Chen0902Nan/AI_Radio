import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import puppeteer, { type Browser } from 'puppeteer-core'
import { moveToTrash } from '../lib/trash.mts'
const require=createRequire(import.meta.url)
const {SAMPLES}=require('@radio/contracts')
const root=path.resolve(import.meta.dirname,'../..')

// 真实浏览器音频解码，供应商和 HTTP 响应均为隔离 fixture，不代表真实音乐/合成验收。
function wav(seconds: number){const rate=8000,n=rate*seconds,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/rate)*800),44+i*2);return b}

test('浏览器：连续歌曲→SSE就绪DJ→歌曲、补歌、暂停恢复与新会话', {timeout:45000},async t=>{
 const clients: Set<import('node:http').ServerResponse>=new Set(),records: any[]=[],requests: string[]=[],errors: string[]=[]
 const tracks=Array.from({length:8},(_,i)=>({id:i+1,name:'测试歌曲'+(i+1),artists:'测试歌手',album:'',durationMs:4000}))
 let sid: string|null=null,sessionNo=0,seq=0,job: { state: string; segueId: string; script: any; audio: { url: string; durationMs: number } }|null=null,nextId=9
 const settings={djEnabled:'true',djIntervalTracks:'3',djVoiceReferenceId:'fixture'}
 const voice={ready:true,voiceReferenceId:'fixture',message:''}
 const push=(data: { type: string; sessionId: any; epoch: any; transitionId: any; segueId: string; state: string })=>{for(const c of clients)c.write(`event: event\ndata: ${JSON.stringify({v:1,seq:++seq,...data})}\n\n`)}
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url || '/','http://fixture');const p=url.pathname;requests.push(p)
   let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{}
   const json=(data: { account?: { nickname: string; userId: number }; liked?: { count: number; tracks: { id: number; name: string; artists: string; album: string; durationMs: number }[] }; playlists?: { created: never[]; collected: never[]; total: number }; settings?: { djEnabled: string; djIntervalTracks: string; djVoiceReferenceId: string }; djVoice?: { ready: boolean; voiceReferenceId: string; message: string }; active?: never[]; session?: { id: any }|{ id: any; adjustments: {} }|{ id: any; adjustments: {} }|null; playId?: number; picks?: { id: number; name: string; artists: string; durationMs: number }[]|{ id: number; name: string; artists: string; reason: string }[]; meta?: { durationMs: number }; playable?: boolean; audioUrl?: string; job?: any })=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,...data}))}
   if(p==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.write(': connected\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return}
   if(p==='/api/library')return json({account:{nickname:'Fixture',userId:1},liked:{count:tracks.length,tracks},playlists:{created:[],collected:[],total:0}})
   if(p==='/api/settings')return json({settings,djVoice:voice})
   if(p==='/api/feedback')return json({active:[]})
   if(p==='/api/health')return json({})
   if(p==='/api/session/start'){sid||='s'+(++sessionNo);return json({session:{id:sid,adjustments:{}}})}
   if(p==='/api/session/stop'){sid=null;return json({})}
   if(p==='/api/session')return json({session:sid?{id:sid,adjustments:{}}:null})
   if(p==='/api/plays/start'){sid||='s'+(++sessionNo);records.push({...body,id:records.length+1,sessionId:sid});return json({playId:records.length,session:{id:sid}})}
   if(p==='/api/plays/end'){const row=records.find(r=>r.id===body.playId);if(row)row.outcome=body.outcome;return json({})}
   if(p==='/api/queue/refill')return json({picks:Array.from({length:5},()=>{const id=nextId++;return{id,name:'补入曲'+id,artists:'测试歌手',durationMs:4000}})})
   if(p==='/api/plan')return json({picks:[{id:80,name:'计划曲',artists:'测试歌手',reason:'fixture'}],meta:{durationMs:1}})
   if(p.startsWith('/api/resolve/'))return json({playable:true,audioUrl:'/api/audio/'+p.split('/').pop()})
   if(p==='/api/dj/prepare'){
    const script=SAMPLES.sourcedScript();Object.assign(script,{transitionId:body.transitionId,targetItemId:body.targetItemId,targetTrackId:body.targetTrackId,targetName:body.targetName})
    const id='fixture-'+Date.now();job={state:'preparing',segueId:id,script,audio:{url:'/api/dj/audio/'+id,durationMs:1000}}
    json({job});const prepared=job
    setTimeout(()=>{prepared.state='ready';push({type:'dj-status',sessionId:body.sessionId,epoch:body.epoch,transitionId:body.transitionId,segueId:id,state:'ready'})},30);return
   }
   if(p.startsWith('/api/dj/jobs/'))return json({job})
   if(p.startsWith('/api/audio/')||p.startsWith('/api/dj/audio/')){const b=wav(p.startsWith('/api/dj/')?1:4);res.writeHead(200,{'content-type':'audio/wav','content-length':b.length});res.end(b);return}
   const file=p.startsWith('/assets/')?path.join(root,'apps/web/dist',p):path.join(root,'apps/web/dist/index.html')
   res.writeHead(200,{'content-type':p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(file))
  }catch(e){errors.push(String(e));res.writeHead(500);res.end('fixture error')}
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()))
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'radio-browser-regression-'))
 let browser: Browser
 t.after(async()=>{await browser?.close();for(const c of clients)c.end();server.closeAllConnections();await new Promise(r=>server.close(r));moveToTrash(profile)})
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile,args:['--mute-audio']})
 const page=await browser.newPage();page.on('pageerror',e=>errors.push((e instanceof Error ? e.message : String(e))))
 await page.goto(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`,{waitUntil:'domcontentloaded'})
 const observation=()=>page.$eval('[data-radio-observation]',el=>JSON.parse((el as HTMLElement).dataset.radioObservation!))
 const click=async (label: string)=>{for(const b of await page.$$('button')){if(await b.evaluate(el=>el.textContent.trim())===label){await b.click();return}}throw Error('找不到按钮 '+label)}
 await page.waitForFunction(()=>JSON.parse(document.querySelector<HTMLElement>('[data-radio-observation]')?.dataset.radioObservation||'{}').queueLength===8)
 assert.equal(await page.$eval('audio',a=>a.paused),true)
 // 此回归用手动红心歌单验证原有 DJ/播放路径；普通混合首批另由 discovery.test 验证。
 for (const button of await page.$$('button')) { if ((await button.evaluate(b => b.textContent.trim())).startsWith('红心歌曲')) { await button.click(); break } }
 await click('开播')
 await page.waitForFunction(()=>document.querySelector('audio')!.currentTime>0.1)
 await click('暂停');const pausedAt=await page.$eval('audio',a=>a.currentTime)
 await click('继续');await page.waitForFunction(t=>document.querySelector('audio')!.currentTime>t+0.1,{},pausedAt)
 // 首次真实音频出声后暂停恢复仍是一条记录。
 assert.equal(records.length,1)
 await page.waitForFunction(()=>document.querySelector('audio')!.src.includes('/api/dj/audio/'),{timeout:18000})
 assert.ok(await page.$eval('main',el=>el.textContent.includes('深夜')))
 assert.ok((await page.$$eval('a[target="_blank"]',els=>els.map(e=>e.href))).length>0)
 await page.waitForFunction(()=>document.querySelector('audio')!.src.includes('/api/audio/4')&&document.querySelector('audio')!.currentTime>0.1)
 // 跳到倒数歌曲，令真实生产装配触发补歌。
 await page.locator('div[title="测试歌曲7 — 测试歌手"]').click()
 await page.waitForFunction(()=>JSON.parse(document.querySelector<HTMLElement>('[data-radio-observation]')!.dataset.radioObservation!).queueLength>8)
 assert.ok(requests.includes('/api/queue/refill'))
 await click('停止');await page.waitForFunction(()=>JSON.parse(document.querySelector<HTMLElement>('[data-radio-observation]')!.dataset.radioObservation!).sessionId===null)
 await click('开播');await page.waitForFunction(()=>document.querySelector('audio')!.src.includes('/api/audio/8')&&document.querySelector('audio')!.currentTime>0.1,{timeout:8000})
 assert.equal((await observation()).sessionId,'s2')
 // 选歌完成不暂停当前音频。
 await click('让 Codex 选歌')
 await page.waitForFunction(()=>document.querySelector('main')!.textContent.includes('Codex 选出 1 首'))
 assert.equal(await page.$eval('audio',a=>a.paused),false)
 assert.ok(records.some(r=>r.outcome==='ended'));assert.deepEqual(errors,[])
})
