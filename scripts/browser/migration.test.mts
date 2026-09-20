import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { moveToTrash } from '../lib/trash.mts'
const require=createRequire(import.meta.url)
const { SAMPLES, validatePrepareRequest }: typeof import('@radio/contracts') = require('@radio/contracts')
const root=path.resolve(import.meta.dirname,'../..')

type FixtureResponse = Partial<import('@radio/contracts').LibraryPayload & import('@radio/contracts').SettingsPayload
 & import('@radio/contracts').FeedbackPayload & import('@radio/contracts').PicksPayload
 & import('@radio/contracts').ResolvePayload & import('@radio/contracts').SessionPayload>
 & { playId?: number; job?: import('@radio/contracts').DjJobInfo | null }
type PlayRecord = import('@radio/contracts').PlayStartRequest & { id: number; outcome?: string }
function responseObject(value: unknown): Record<string, unknown> {
 assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'fixture 请求必须是对象')
 // JSON 容器的唯一断言；需要使用的字段继续由路由校验。
 return value as Record<string, unknown>
}
async function requestBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
 let raw = ''
 const chunks: AsyncIterable<unknown> = request
 for await (const chunk of chunks) {
  assert.ok(typeof chunk === 'string' || Buffer.isBuffer(chunk))
  raw += chunk.toString()
 }
 const value: unknown = raw ? JSON.parse(raw) : {}
 return responseObject(value)
}
function playRequest(body: Record<string, unknown>): import('@radio/contracts').PlayStartRequest {
 assert.ok(typeof body.trackId === 'number')
 assert.ok(typeof body.trackName === 'string')
 assert.ok(typeof body.artists === 'string')
 assert.ok(body.playInstanceId === undefined || typeof body.playInstanceId === 'string')
 assert.ok(body.selectionId === undefined || typeof body.selectionId === 'string')
 return { trackId: body.trackId, trackName: body.trackName, artists: body.artists,
  playInstanceId: body.playInstanceId, selectionId: body.selectionId }
}
async function observation(page: Page): Promise<{ queueLength: number; sessionId: string | null }> {
 const raw = await page.$eval('[data-radio-observation]', element => (element as HTMLElement).dataset.radioObservation!)
 const value: unknown = JSON.parse(raw)
 const data = responseObject(value)
 assert.ok(typeof data.queueLength === 'number')
 assert.ok(data.sessionId === null || typeof data.sessionId === 'string')
 return { queueLength: data.queueLength, sessionId: data.sessionId }
}
async function waitForQueue(page: Page, count: number, greater = false): Promise<void> {
 await page.waitForFunction((expected, more) => {
  const value: unknown = JSON.parse(document.querySelector<HTMLElement>('[data-radio-observation]')?.dataset.radioObservation || '{}')
  if (!value || typeof value !== 'object' || !('queueLength' in value) || typeof value.queueLength !== 'number') return false
  return more ? value.queueLength > expected : value.queueLength === expected
 }, {}, count, greater)
}

// 真实浏览器音频解码，供应商和 HTTP 响应均为隔离 fixture，不代表真实音乐/合成验收。
function wav(seconds: number){const rate=8000,n=rate*seconds,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/rate)*800),44+i*2);return b}

test('浏览器：连续歌曲→SSE就绪DJ→歌曲、补歌、暂停恢复与新会话', {timeout:45000},async t=>{
 const clients: Set<import('node:http').ServerResponse>=new Set(),records: PlayRecord[]=[],requests: string[]=[],errors: string[]=[]
 const tracks=Array.from({length:8},(_,i)=>({id:i+1,name:'测试歌曲'+(i+1),artists:'测试歌手',album:'',durationMs:4000}))
 let sid: string|null=null,sessionNo=0,seq=0,job: import('@radio/contracts').DjJobInfo | null = null,nextId=9
 const settings={djEnabled:'true',djIntervalTracks:'3',djVoiceReferenceId:'fixture'}
 const voice={ready:true,voiceReferenceId:'fixture',message:'',code:null}
 const push=(data: { type: 'dj-status'; sessionId: string; epoch: number; transitionId: string; segueId: string; state: 'ready' })=>{for(const c of clients)c.write(`event: event\ndata: ${JSON.stringify({v:1,seq:++seq,...data})}\n\n`)}
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url || '/','http://fixture');const p=url.pathname;requests.push(p)
   const body = await requestBody(req)
   const json=(data: FixtureResponse)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,...data}))}
   if(p==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.write(': connected\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return}
   if(p==='/api/library')return json({account:{nickname:'Fixture',userId:1},liked:{count:tracks.length,tracks},playlists:{created:[],collected:[],total:0}})
   if(p==='/api/settings')return json({settings,djVoice:voice})
   if(p==='/api/feedback')return json({active:[]})
   if(p==='/api/health')return json({})
   if(p==='/api/session/start'){sid||='s'+(++sessionNo);return json({session:{id:sid,adjustments:{},highest_epoch:0,transition_seq:-1}})}
   if(p==='/api/session/stop'){sid=null;return json({})}
   if(p==='/api/session')return json({session:sid?{id:sid,adjustments:{},highest_epoch:0,transition_seq:-1}:null})
   if(p==='/api/plays/start'){sid||='s'+(++sessionNo);records.push({...playRequest(body),id:records.length+1,sessionId:sid});return json({playId:records.length,session:{id:sid,adjustments:{},highest_epoch:0,transition_seq:-1}})}
   if(p==='/api/plays/end'){assert.ok(typeof body.playId === 'number' && typeof body.outcome === 'string');const row=records.find(r=>r.id===body.playId);if(row)row.outcome=body.outcome;return json({})}
   if(p==='/api/queue/refill')return json({picks:Array.from({length:5},()=>{const id=nextId++;return{id,name:'补入曲'+id,artists:'测试歌手',durationMs:4000,reason:''}})})
   if(p==='/api/plan')return json({picks:[{id:80,name:'计划曲',artists:'测试歌手',reason:'fixture'}],meta:{durationMs:1}})
   if(p.startsWith('/api/resolve/'))return json({playable:true,audioUrl:'/api/audio/'+p.split('/').pop()})
   if(p==='/api/dj/prepare'){
    const parsed=validatePrepareRequest(body);assert.ok(parsed.ok && parsed.value, 'DJ 请求通过共享契约');const prepare=parsed.value
    const script=SAMPLES.sourcedScript();Object.assign(script,{transitionId:prepare.transitionId,targetItemId:prepare.targetItemId,targetTrackId:prepare.targetTrackId,targetName:prepare.targetName})
    const id='fixture-'+Date.now();job={state:'preparing',segueId:id,script,audio:{assetId:id,url:'/api/dj/audio/'+id,durationMs:1000,bytes:wav(1).length}}
    json({job});const prepared=job
    setTimeout(()=>{prepared.state='ready';push({type:'dj-status',sessionId:prepare.sessionId,epoch:prepare.epoch,transitionId:prepare.transitionId,segueId:id,state:'ready'})},30);return
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
 const click=async (label: string)=>{for(const b of await page.$$('button')){if(await b.evaluate(el=>el.textContent.trim())===label){await b.click();return}}throw Error('找不到按钮 '+label)}
 await waitForQueue(page, 8)
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
 await waitForQueue(page, 8, true)
 assert.ok(requests.includes('/api/queue/refill'))
 await click('停止');await page.waitForFunction(() => {
  const value: unknown = JSON.parse(document.querySelector<HTMLElement>('[data-radio-observation]')!.dataset.radioObservation!)
  return value !== null && typeof value === 'object' && 'sessionId' in value && value.sessionId === null
 })
 await click('开播');await page.waitForFunction(()=>document.querySelector('audio')!.src.includes('/api/audio/8')&&document.querySelector('audio')!.currentTime>0.1,{timeout:8000})
 assert.equal((await observation(page)).sessionId,'s2')
 // 选歌完成不暂停当前音频。
 await click('让 Codex 选歌')
 await page.waitForFunction(()=>document.querySelector('main')!.textContent.includes('Codex 选出 1 首'))
 assert.equal(await page.$eval('audio',a=>a.paused),false)
 assert.ok(records.some(r=>r.outcome==='ended'));assert.deepEqual(errors,[])
})
