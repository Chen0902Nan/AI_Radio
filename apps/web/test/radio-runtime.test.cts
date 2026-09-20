class MockEventSource {
 url: string
 listeners: Record<string, (event: {data: string | undefined}) => void> = {}
 closed = false
 constructor(url: string) { this.url = url }
 addEventListener(name: string, listener: (event: {data: string | undefined}) => void) { this.listeners[name] = listener }
 close() { this.closed = true }
 emit(name: string, data?: unknown) { this.listeners[name]?.({data: JSON.stringify(data)}) }
}
const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const {setup,flush,item,deferred,deferredFor,sessionInfo}: import('./support/runtime.cts').RuntimeSupport = require('./support/runtime.cts')

test('自动补歌成功后，新曲实际进入待播队列且当前曲继续播放',async (t)=>{
 const {runtime:r,audio}=setup(t)
 await r.playback.play(0);audio.emit('playing');await flush()
 assert.deepEqual(r.playback.queue.map(t=>t.trackId),[101,102,999])
 assert.equal(r.playback.getSnapshot().currentTrackId,101)
 assert.equal(audio.paused,false)
})

test('长队列消耗到补歌阈值后自动补入新曲',async (t)=>{
 const {runtime:r,audio}=setup(t,[1,2,3,4,5])
 await r.playback.play(0);audio.emit('playing');await flush()
 await r.playback.play(3);audio.emit('playing');await flush()
 assert.deepEqual(r.playback.queue.map(t=>t.trackId),[1,2,3,4,5,999])
})

test('队尾等待期间补歌到达后自动接上',async (t)=>{
 const batch=deferredFor('refill')
 const {runtime:r,audio}=setup(t,[1],{refill:()=>batch.promise})
 await r.playback.play(0);audio.emit('playing');await flush()
 audio.emit('ended');await flush()
 batch.resolve({ok:true,picks:[{id:2,name:'新曲',artists:'歌手',reason:''}]});await flush()
 assert.equal(r.playback.getSnapshot().currentTrackId,2)
 assert.equal(audio.paused,false)
})

test('停止后迟到的补歌不进入队列',async (t)=>{
 const batch=deferredFor('refill')
 const {runtime:r,audio}=setup(t,[1],{refill:()=>batch.promise})
 await r.playback.play(0);audio.emit('playing');await flush()
 r.playback.stop()
 batch.resolve({ok:true,picks:[{id:2,name:'迟到曲',artists:'歌手',reason:''}]});await flush()
 assert.deepEqual(r.playback.queue.map(t=>t.trackId),[1])
 assert.equal(audio.paused,true)
})

test('单曲无权限自动跳过，连续三首失败后有界停止',async (t)=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const {runtime:r,audio}=setup(t,[1,2,3,4,5],{resolve:async()=>({ok:true,playable:false,audioUrl:null,code:'unplayable'})})
 await r.playback.play(0)
 t.mock.timers.tick(1200);await flush()
 assert.equal(r.playback.getSnapshot().currentTrackId,2)
 t.mock.timers.tick(1200);await flush()
 t.mock.timers.tick(10000);await flush()
 assert.equal(r.playback.getSnapshot().currentTrackId,3)
 assert.equal(r.playback.getSnapshot().userWantsPlayback,false)
 assert.equal(audio.paused,true)
})

test('停止后重开从原位置继续，新会话的歌曲自然结束仍自动下一首',async (t)=>{
 const {runtime:r,audio,api}=setup(t,[1,2,3,4,5])
 await r.playback.play(0);audio.emit('playing');await flush()
 audio.currentTime=50
 r.playback.stop();await api.sessionStop();r.store.set({sessionId:null,playId:null})
 const s=await api.sessionStart();r.store.set({sessionId:(s.ok && s.session ? s.session.id : null)})
 await r.playback.resume();audio.emit('playing');await flush()
 assert.equal(audio.currentTime,50)
 audio.emit('ended');await flush()
 assert.equal(r.playback.getSnapshot().currentTrackId,2)
})

test('每首实际出声有独立播放记录，暂停恢复不重复，结束和跳过正确收尾',async (t)=>{
 const {runtime:r,audio,records}=setup(t,[1,2,3,4,5])
 await r.playback.play(0);audio.emit('playing');await flush()
 audio.currentTime=10;r.playback.pause();await r.playback.resume();audio.emit('playing');await flush()
 audio.emit('ended');await flush();audio.emit('playing');await flush()
 await r.playback.skipTo(2);audio.emit('playing');await flush()
 assert.deepEqual(records.map(x=>[x.trackId,x.outcome]),[[1,'ended'],[2,'skipped'],[3,null]])
})

test('切换音乐来源作废旧补歌，新来源不会混入迟到批次',async (t)=>{
 const batch=deferredFor('refill')
 const {runtime:r,audio}=setup(t,[1],{refill:()=>batch.promise})
 await r.playback.play(0);audio.emit('playing');await flush()
 r.playback.replaceQueue([item(20)])
 batch.resolve({ok:true,picks:[{id:2,name:'迟到曲',artists:'歌手',reason:''}]});await flush()
 assert.deepEqual(r.playback.queue.map(t=>t.trackId),[20])
})

test('应用新选歌计划只更新待播列表，保留当前曲和播放时间',async (t)=>{
 const {runtime:r,audio}=setup(t,[1,2,3,4,5])
 await r.playback.play(1);audio.emit('playing');await flush();audio.currentTime=42
 r.playback.replaceUpcoming([item(20),item(21)])
 assert.deepEqual(r.playback.queue.map(t=>t.trackId),[1,2,20,21])
 assert.equal(r.playback.getSnapshot().currentTrackId,2)
 assert.equal(audio.currentTime,42)
 assert.equal(audio.paused,false)
})

test('暂停期间到达的补歌只入队，不自动出声',async (t)=>{
 const batch=deferredFor('refill');const {runtime:r,audio}=setup(t,[1],{refill:()=>batch.promise})
 await r.playback.play(0);audio.emit('playing');await flush();audio.emit('ended');r.playback.pause()
 batch.resolve({ok:true,picks:[{id:2,name:'待播',artists:'歌手',reason:''}]});await flush()
 assert.deepEqual(r.playback.queue.map(t=>t.trackId),[1,2]);assert.equal(audio.paused,true)
})

test('播放开始响应迟于停止，记录仍收尾且不恢复会话',async (t)=>{
 const start=deferredFor('playStart'),ended: unknown[][]=[]
 const {runtime:r,audio}=setup(t,[1,2,3,4,5],{playStart:()=>start.promise,playEnd:async(id,outcome)=>{ended.push([id,outcome]);return{ok:true}}})
 await r.playback.play(0);audio.emit('playing');r.playback.stop();r.store.set({sessionId:null})
 start.resolve({ok:true,playId:77,session:sessionInfo('old')});await flush()
 assert.deepEqual(ended,[[77,'stopped']]);assert.equal(r.store.get().sessionId,null)
})

test('坏歌的延迟重试不能覆盖用户暂停或手动选曲',async (t)=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const {runtime:r,audio}=setup(t,[1,2,3,4,5],{resolve:async (id: string|number)=>id===1?{ok:true,playable:false,audioUrl:null,code:'unplayable'}:{ok:true,playable:true,audioUrl:'/api/audio/'+id}})
 await r.playback.play(0);r.playback.pause();t.mock.timers.tick(1200);await flush()
 assert.equal(r.playback.getSnapshot().currentTrackId,1);assert.equal(audio.paused,true)
 await r.playback.play(0);await r.playback.play(3);t.mock.timers.tick(1200);await flush()
 assert.equal(r.playback.getSnapshot().currentTrackId,4)
})

test('SSE首次连接和重连读取配置快照，但不自动开播',async (t: import('node:test').TestContext)=>{
 const saved=global.EventSource,streams: MockEventSource[]=[]
 global.EventSource = class extends MockEventSource { constructor(url: string) { super(url); streams.push(this) } } as unknown as typeof EventSource
 t.after(()=>{global.EventSource=saved})
 let voice='voice-a'
 const {runtime:r,audio}=setup(t,[1,2,3,4,5],{settings:async()=>({ok:true,settings:{djEnabled:'false'},djVoice:{ready:true,voiceReferenceId:voice,message:'',code:null}})})
 const disconnect=r.connect();t.after(disconnect)
 assert.equal(streams[0].url,'/api/events')
 streams[0].emit('open');await flush()
 assert.equal(r.store.get().djVoice?.voiceReferenceId,'voice-a')
 voice='voice-b';streams[0].emit('error');streams[0].emit('open');await flush()
 assert.equal(r.store.get().djVoice?.voiceReferenceId,'voice-b');assert.equal(audio.paused,true)
 disconnect();assert.equal(streams[0].closed,true)
})

test('SSE配置事件过滤旧会话与重复序号，合法通知刷新快照',async (t: import('node:test').TestContext)=>{
 const saved=global.EventSource,streams: MockEventSource[]=[]
 global.EventSource = class extends MockEventSource { constructor(url: string) { super(url); streams.push(this) } } as unknown as typeof EventSource
 t.after(()=>{global.EventSource=saved})
 let voice='a'
 const {runtime:r}=setup(t,[1,2,3,4,5],{settings:async()=>({ok:true,settings:{djEnabled:'false'},djVoice:{ready:true,voiceReferenceId:voice,code:null,message:''}})})
 r.store.set({sessionId:'s1'});const off=r.connect();t.after(off);const s=streams[0];s.emit('open');await flush()
 voice='b';s.emit('event',{v:1,seq:1,type:'config-changed',sessionId:'old'});await flush();assert.equal(r.store.get().djVoice?.voiceReferenceId,'a')
 s.emit('event',{v:1,seq:2,type:'config-changed',sessionId:'s1'});await flush();assert.equal(r.store.get().djVoice?.voiceReferenceId,'b')
 voice='c';s.emit('event',{v:1,seq:2,type:'config-changed',sessionId:'s1'});await flush();assert.equal(r.store.get().djVoice?.voiceReferenceId,'b')
})

test('DJ就绪推送立即查任务并接管串场，连接正常时不周期轮询',async (t: import('node:test').TestContext)=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const saved=global.EventSource,streams: MockEventSource[]=[]
 global.EventSource = class extends MockEventSource { constructor(url: string) { super(url); streams.push(this) } } as unknown as typeof EventSource
 t.after(()=>{global.EventSource=saved})
 let request!: import('@radio/contracts').PrepareRequest,jobQueries=0,ready=false
 const {SAMPLES}: typeof import('@radio/contracts') = require('@radio/contracts')
 const {runtime:r,audio}=setup(t,[1,2,3,4,5,6],{
 settings:async()=>({ok:true,settings:{djEnabled:'true',djIntervalTracks:'3'}}),
 djPrepare:async (req)=>{request=req;return{ok:true,job:{state:'preparing',segueId:'sg-test'}}},
 djJob:async()=>{jobQueries++;const j=SAMPLES.readyJob();Object.assign(j.script,{transitionId:request.transitionId,targetItemId:request.targetItemId,targetTrackId:request.targetTrackId});return{ok:true,job:{state:ready?'ready':'preparing',segueId:'sg-test',script:j.script,audio:j.audio}}},
 djCancel:async()=>({ok:true})})
 const off=r.connect();t.after(off);streams[0].emit('open');await flush()
 await r.playback.play(0);audio.emit('playing');await flush()
 for(let i=0;i<2;i++){audio.emit('ended');await flush();audio.emit('playing');await flush()}
 assert.ok(request)
 const baseline=jobQueries;t.mock.timers.tick(6000);await flush();assert.equal(jobQueries,baseline)
 streams[0].emit('event',{v:1,seq:1,type:'dj-status',sessionId:'s1',epoch:request.epoch,transitionId:'old',segueId:'wrong'});await flush();assert.equal(jobQueries,baseline)
 streams[0].emit('error');t.mock.timers.tick(2000);await flush();assert.equal(jobQueries,baseline+1)
 streams[0].emit('open');await flush();const afterReconnect=jobQueries
 t.mock.timers.tick(6000);await flush();assert.equal(jobQueries,afterReconnect)
 ready=true;streams[0].emit('event',{v:1,seq:1,type:'dj-status',sessionId:'s1',epoch:request.epoch,transitionId:request.transitionId,segueId:'sg-test',state:'ready'});await flush()
 audio.emit('ended');await flush()
 assert.equal(r.playback.getSnapshot().currentKind,'segue')
 assert.ok(r.store.get().djScript?.scriptText)
})

test('DJ面板显示完整文案和可点击来源',async (t)=>{
 const {runtime:r}=setup(t,[1,2,3,4,5])
 const {SAMPLES}: typeof import('@radio/contracts') = require('@radio/contracts')
 const script=SAMPLES.sourcedScript()
 r.store.set({djScript:script})
 const React: typeof import('react') = require('react')
 const {renderToStaticMarkup}: typeof import('react-dom/server') = require('react-dom/server')
 // JSX组件只在 SSR 边界按 React 函数组件类型加载；核心 runtime 保留完整生产接口。
 const {RadioProvider}: {RadioProvider: import('react').ComponentType<{children?: import('react').ReactNode}>} = require('../src/app/radio-context.tsx')
 const {DjPanel}: {DjPanel: import('react').ComponentType} = require('../src/features/dj/DjPanel.tsx')
 const html=renderToStaticMarkup(React.createElement(RadioProvider,null,React.createElement(DjPanel)))
 assert.ok(html.includes(script.scriptText))
 assert.ok(html.includes('href="'+script.sources[0].url+'"'))
})

test('在队尾点击下一首继续等待补歌，而不是丢失收听意图',async (t)=>{
 const batch=deferredFor('refill');const {runtime:r,audio}=setup(t,[1],{refill:()=>batch.promise})
 await r.playback.play(0);audio.emit('playing');await flush();await r.playback.skipTo(1)
 batch.resolve({ok:true,picks:[{id:2,name:'下一首',artists:'歌手',reason:''}]});await flush()
 assert.equal(r.playback.getSnapshot().currentTrackId,2);assert.equal(audio.paused,false)
})

test('暂停中的DJ继续原播报，不重新播放上一首歌曲',async (t)=>{
 const {runtime:r,audio}=setup(t,[1,2,3,4,5])
 await r.playback.play(0);audio.emit('playing');await flush()
 await r.playback.playSegue({segueId:'intro',audio:{url:'/api/dj/audio/intro',durationMs:20000},script:{targetName:'下一首'}})
 audio.emit('playing');audio.currentTime=6;r.playback.pause()
 await r.playback.resume();audio.emit('playing')
 assert.ok(audio.src.includes('/api/dj/audio/intro'));assert.equal(audio.currentTime,6);assert.equal(r.playback.getSnapshot().currentKind,'segue')
})

test('补歌达到失败上限后，用户恢复收听能够重新尝试',async (t)=>{
 const {runtime:r,audio,api}=setup(t,[1],{refill:async()=>({ok:false,code:'music_unavailable'})})
 r.refill.setConfig({maxAttempts:1});await r.playback.play(0);audio.emit('playing');await flush()
 assert.match(r.store.get().prepStatus.text,/暂停/)
 api.refill=async()=>({ok:true,status:200,picks:[{id:2,name:'恢复曲',artists:'歌手',reason:''}]})
 audio.currentTime=10;r.playback.pause();await r.playback.resume();audio.emit('playing');await flush()
 assert.deepEqual(r.playback.queue.map(t=>t.trackId),[1,2])
})

test('旧audio.play迟到完成不能暂停用户刚切换的新曲',async (t)=>{
 const {runtime:r,audio}=setup(t,[1,2,3,4,5])
 const old=deferred();let calls=0
 audio.play=()=>{audio.paused=false;return ++calls===1?old.promise:Promise.resolve()}
 const first=r.playback.play(0);await flush()
 await r.playback.play(1);old.resolve();await first
 assert.equal(r.playback.getSnapshot().currentTrackId,2);assert.equal(audio.paused,false)
})

test('普通开播等混合首批，准备期间不出声，实际播放携带来源与实例身份',async (t)=>{
 const batch=deferredFor('refill')
 const {runtime:r,audio,records}=setup(t,[1,2],{refill:()=>batch.promise})
 const start=r.startListening();await flush()
 assert.equal(audio.paused,true)
 assert.equal(r.store.get().preparingStart,true)
 batch.resolve({ok:true,picks:[{id:11,name:'探索曲',artists:'歌手',reason:'',selectionId:'selection-11',selectionSource:'discovery'}]})
 await start;audio.emit('playing');await flush()
 assert.equal(r.playback.getSnapshot().currentTrackId,11)
 assert.equal(records[0].selectionId,'selection-11')
 assert.ok(records[0].playInstanceId)
})

test('首批准备期间暂停或停止，迟到结果不出声也不覆盖原队列',async (t)=>{
 const batch=deferredFor('refill');const {runtime:r,audio}=setup(t,[1,2],{refill:()=>batch.promise})
 const start=r.startListening();await flush();r.playback.pause()
 batch.resolve({ok:true,picks:[{id:11,name:'迟到',artists:'歌手',reason:''}]});await start
 assert.equal(audio.paused,true);assert.deepEqual(r.playback.queue.map(t=>t.trackId),[1,2])
})
test('手动歌单保持人工来源，结束后自动接混合歌曲',async (t)=>{
 const {runtime:r,audio,records}=setup(t,[1,2],{refill:async()=>({ok:true,picks:[{id:11,name:'探索',artists:'歌手',reason:'',selectionId:'auto-11',selectionSource:'discovery'}]})})
 r.selectManual([item(7)],'手动歌单')
 await r.startListening();audio.emit('playing');await flush();audio.emit('ended');await flush();audio.emit('playing');await flush()
 assert.equal(r.playback.getSnapshot().currentTrackId,11)
 assert.equal(records[0].selectionId,undefined);assert.equal(records[1].selectionId,'auto-11')
})

test('停止先于 session/start 返回时不留下迟到的活动会话',async (t)=>{
 const started=deferred();let open=false
 const {runtime:r}=setup(t,[1],{sessionStart:async()=>{await started.promise;open=true;return{ok:true,session:sessionInfo('late')}},sessionStop:async()=>{open=false;return{ok:true}}})
 const start=r.startListening();await flush();await r.stopListening();started.resolve();await start
 assert.equal(open,false);assert.equal(r.store.get().sessionId,null)
})

test('音色合成期间开播再停止，旧试听结果不能恢复声音', async (t: import('node:test').TestContext) => {
  const pendingPreview = deferredFor('djPreview')
  const { runtime: r, audio } = setup(t, [101, 102], {
    djPreview: () => pendingPreview.promise,
  })
  r.preview.edit('fixture')
  const preview = r.preview.preview()
  await r.startListening()
  await r.stopListening()
  pendingPreview.resolve({ ok: true, audio: { assetId: 'obsolete', bytes: 4096, url: '/api/dj/audio/obsolete', durationMs: 1000 } })
  await preview
  assert.equal(audio.paused, true)
  assert.doesNotMatch(audio.src, /obsolete/)
  assert.equal(r.preview.getSnapshot().canSave, false)
})

test('服务端持久版本恢复后，首批补歌与串场共用更高版本', async (t: import('node:test').TestContext) => {
  const watermark = Date.now() + 1000000
  let refillEpoch = 0
  const { runtime: r } = setup(t, [], {
    sessionStart: async () => ({ ok: true, session: { adjustments: {}, id: 'existing', highest_epoch: watermark, transition_seq: 12 } }),
    refill: async (request: { epoch: number }) => {
      refillEpoch = request.epoch
      return { ok: true, picks: [{ id: 1, name: 'fixture', artists: 'fixture', reason: '' }] }
    },
  })
  await r.startListening()
  assert.ok(refillEpoch > watermark)
  assert.ok(r.refill.epoch >= refillEpoch)
  assert.equal(r.segue.snapshot().epoch, r.refill.epoch)
})

// 静态回归：fixture 参数错误必须被 tools typecheck 拒绝。
if (false) {
 // @ts-expect-error resolver 的歌曲 ID 只能是 number
 setup({ after() {} }, [1], { resolve: async (id: string) => ({ ok: true, playable: true, audioUrl: '/api/audio/' + id }) })
}
