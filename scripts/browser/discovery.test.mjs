import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import puppeteer from 'puppeteer-core'
import {moveToTrash} from '../lib/trash.mjs'
const root=path.resolve(import.meta.dirname,'../..')
function wav(){const n=8000*20,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b}
const song=id=>({id,name:'歌曲'+id,artists:'测试歌手',durationMs:20000})
test('真实浏览器：首批等待、来源记录、停止不误播、手动歌单后自动接回混合电台',async t=>{
 let sid=null, next=10, pendingBatch=null, delay=true
 const records=[],errors=[],clients=new Set()
 const server=http.createServer(async(req,res)=>{
  const p=new URL(req.url,'http://fixture').pathname
  let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{}
  const json=d=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,...d}))}
  if(p==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(':ok\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return}
  if(p==='/api/library')return json({liked:{count:2,tracks:[song(1),song(2)]},playlists:{created:[{id:9,name:'手动歌单',trackCount:1}],collected:[],total:1}})
  if(p==='/api/playlist/9')return json({tracks:[song(7)],returned:1,trackCount:1,via:'fixture'})
  if(p==='/api/settings')return json({settings:{djEnabled:'false'}})
  if(p==='/api/feedback')return json({active:[]})
  if(p==='/api/session/start'){sid='fixture-session';return json({session:{id:sid}})}
  if(p==='/api/session/stop'){sid=null;return json({})}
  if(p==='/api/session')return json({session:sid?{id:sid}:null})
  if(p==='/api/queue/refill'){
   const respond=()=>json({picks:Array.from({length:5},(_,i)=>{const id=next++;return {...song(id),selectionId:'selection-'+id,selectionSource:i%2?'library':'discovery'}})})
   if(delay)pendingBatch=respond;else respond();return
  }
  if(p==='/api/plays/start'){records.push(body);return json({playId:records.length,session:{id:sid}})}
  if(p==='/api/plays/end')return json({})
  if(p.startsWith('/api/resolve/'))return json({playable:true,audioUrl:'/api/audio/'+p.split('/').pop()})
  if(p.startsWith('/api/audio/')){const b=wav();res.writeHead(200,{'content-type':'audio/wav','content-length':b.length});res.end(b);return}
  const file=p.startsWith('/assets/')?path.join(root,'apps/web/dist',p):path.join(root,'apps/web/dist/index.html')
  res.writeHead(200,{'content-type':p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(file))
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'radio-discovery-browser-'))
 let browser
 t.after(async()=>{await browser?.close();for(const c of clients)c.end();server.closeAllConnections();await new Promise(r=>server.close(r));moveToTrash(profile)})
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile,args:['--mute-audio']})
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message))
 const click=async text=>{for(const b of await page.$$('button'))if((await b.evaluate(el=>el.textContent.trim())).startsWith(text)){await b.click();return}throw Error('missing '+text)}
 await page.goto(`http://127.0.0.1:${server.address().port}/`)
 await page.waitForFunction(()=>document.body.textContent.includes('手动歌单'))
 await click('开播');await page.waitForFunction(()=>document.body.textContent.includes('正在准备混合首批'))
 assert.equal(await page.$eval('audio',a=>a.paused),true);assert.equal(records.length,0)
 assert.equal(await page.$$eval('button',bs=>bs.find(b=>b.textContent.trim()==='下一首').disabled),true)
 await click('停止');await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-radio-observation]').dataset.radioObservation).sessionId===null)
 while(!pendingBatch)await new Promise(r=>setTimeout(r,10));pendingBatch();pendingBatch=null
 await page.waitForFunction(()=>document.body.textContent.includes('已停止收听'))
 assert.equal(await page.$eval('audio',a=>a.paused),true)
 delay=false;await click('开播');await page.waitForFunction(()=>document.querySelector('audio').currentTime>0.1)
 assert.ok(records.at(-1).selectionId);assert.ok(records.at(-1).playInstanceId)
 await click('停止');await click('手动歌单');await page.waitForFunction(()=>document.body.textContent.includes('读取到 1/1'))
 await click('开播');await page.waitForFunction(()=>document.querySelector('audio').src.includes('/api/audio/7')&&document.querySelector('audio').currentTime>0.1)
 assert.equal(records.at(-1).trackId,7);assert.equal(records.at(-1).selectionId,undefined)
 await page.$eval('audio',a=>{a.currentTime=a.duration-0.15})
 await page.waitForFunction(()=>!document.querySelector('audio').src.includes('/api/audio/7')&&document.querySelector('audio').currentTime>0.1)
 assert.ok(records.at(-1).selectionId);assert.deepEqual(errors,[])
})
