const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const fs: typeof import('node:fs') = require('node:fs')
const os: typeof import('node:os') = require('node:os')
const path: typeof import('node:path') = require('node:path')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-discovery-'))
process.env.RADIO_DATA_DIR = dir
process.env.RADIO_DB_FILE = path.join(dir, 'radio.db')
require('reflect-metadata')
const { NestFactory }: typeof import('@nestjs/core') = require('@nestjs/core')
const { AppModule }: typeof import('../../apps/api/dist/app.module.js') = require('../../apps/api/dist/app.module.js')
let app: import('@nestjs/common').INestApplication, base: string
const { parseSession, parsePicks, parsePlayStart }: typeof import('@radio/contracts') = require('@radio/contracts')
interface ResponseMeta { status: number; ok: boolean; code?: string; message: string; degraded: boolean }
type BatchResponse = ResponseMeta & import('@radio/contracts').PicksPayload
interface HistoryRow { track_id: number; selection_source?: 'library' | 'discovery' | null }
interface HistoryResponse extends ResponseMeta { automatic: HistoryRow[]; recent: HistoryRow[] }
function responseObject(value: unknown): Record<string, unknown> {
 assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'HTTP 返回对象')
 // 只在 JSON 对象边界断言容器；实际使用字段由下面的解析器逐项校验。
 return value as Record<string, unknown>
}
function historyRows(value: unknown): HistoryRow[] {
 assert.ok(Array.isArray(value), '历史记录必须是数组')
 return value.map((entry: unknown) => {
  const row = responseObject(entry)
  assert.ok(typeof row.track_id === 'number')
  assert.ok(row.selection_source === undefined || row.selection_source === null || row.selection_source === 'library' || row.selection_source === 'discovery')
  return { track_id: row.track_id, selection_source: row.selection_source }
 })
}
function responseMeta(res: Response, data: Record<string, unknown>): ResponseMeta {
 return { status: res.status, ok: data.ok !== false && res.ok,
  code: typeof data.code === 'string' ? data.code : undefined,
  message: typeof data.message === 'string' ? data.message : '', degraded: data.degraded === true }
}
function call(route: 'session/start', body: Record<string, unknown>): Promise<ResponseMeta & { session: import('@radio/contracts').SessionInfo }>
function call(route: 'queue/refill' | 'plan', body: Record<string, unknown>): Promise<BatchResponse>
function call(route: 'plays/history', body?: undefined): Promise<HistoryResponse>
function call(route: 'plays/start', body: Record<string, unknown>): Promise<ResponseMeta & import('@radio/contracts').PlayStartPayload>
function call(route: string, body?: Record<string, unknown>): Promise<ResponseMeta>
async function call(route: string, body?: Record<string, unknown>): Promise<unknown> {
 const res = await fetch(base + '/api/' + route, body === undefined ? {} : {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)})
 const value: unknown = await res.json()
 const data = responseObject(value)
 const meta = responseMeta(res, data)
 if (route === 'session/start') {
  const parsed = parseSession(data)
  assert.ok(parsed.session, '开始收听必须返回会话')
  return { ...meta, session: parsed.session }
 }
 if (route === 'queue/refill' || route === 'plan') return { ...meta, ...(meta.ok ? parsePicks(data) : { picks: [] }) }
 if (route === 'plays/history') return { ...meta, automatic: historyRows(data.automatic), recent: historyRows(data.recent) }
 if (route === 'plays/start') return { ...meta, ...parsePlayStart(data) }
 return meta
}
test.before(async () => { app = await NestFactory.create(AppModule, {logger:false}); await app.listen(0,'127.0.0.1'); base = await app.getUrl() })
test.after(async () => { await app?.close(); const trash=path.join(os.homedir(),'.Trash'); fs.mkdirSync(trash,{recursive:true}); fs.renameSync(dir,path.join(trash,path.basename(dir))) })
test('播放记录 API 对同一播放实例幂等，手动播放不进入自动比例窗口', async () => {
 const {session} = await call('session/start', {})
 const body = {trackId:101, trackName:'手动曲', sessionId:session.id, playInstanceId:'manual-1'}
 const first = await call('plays/start',body), duplicate = await call('plays/start',body)
 assert.equal(duplicate.playId, first.playId)
 const history = await call('plays/history')
 assert.deepEqual(history.automatic, [])
 assert.equal(history.recent.filter((p)=>p.track_id===101).length, 1)
})
// 第三方无声明；供应商输入均为对象，输出必须走生产 unknown 校验。
const upstream: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = require('@neteasecloudmusicapienhanced/api')
const {NeteaseService}: typeof import('../../apps/api/dist/music/netease.service.js') = require('../../apps/api/dist/music/netease.service.js')
const {setCodexMode}: typeof import('../../apps/api/dist/codex/codex.service.js') = require('../../apps/api/dist/codex/codex.service.js')
const song = (id: string|number) => ({id,name:'曲'+id,ar:[{name:'歌手'}],al:{name:'专辑'},dt:200000})
function musicFixture(identity='fixture') {
 const ncm = app.get(NeteaseService)
 ncm.loadSession = () => ({cookie:'fixture-'+identity,profile:{userId:1},savedAt:new Date().toISOString()})
 Object.assign(upstream, {
 likelist:async()=>({body:{code:200,ids:[1,2]}}),
 user_playlist:async({offset}: Record<string, unknown>)=>({body:{code:200,playlist:offset?[]:[{id:10,name:'测试歌单',userId:1,trackCount:2}],more:false}}),
 playlist_detail:async()=>({body:{code:200,playlist:{trackCount:2,trackIds:[{id:3},{id:4}]}}}),
 song_detail:async({ids}: Record<string, unknown>)=>({body:{code:200,songs:String(ids).split(',').map(Number).map(song)}}),
 recommend_songs:async()=>({body:{code:200,data:{dailySongs:[3,11,12,13,14].map(song)}}}),
 simi_song:async()=>({body:{code:200,songs:[11,12,13,14].map(song)}}),
 song_url_v1:async({id}: Record<string, unknown>)=>({body:{code:200,data:[{id,url:'https://example.com/'+id,expi:1200}]}}),
 })
 process.env.RADIO_TEST_HOOKS='1';setCodexMode('success')
}
test('选歌 API 合并自建歌单且排除歌单内伪探索，返回约各半的完整可播歌曲', async()=>{
 musicFixture()
 const {session}=await call('session/start',{})
 const batch=await call('queue/refill',{sessionId:session.id,epoch:1,count:4})
 assert.equal(batch.ok,true)
 assert.deepEqual(batch.picks.map((p)=>p.selectionSource).sort(),['discovery','discovery','library','library'])
 assert.ok(batch.picks.filter((p)=>p.selectionSource==='discovery').every((p)=>p.id>=11))
 assert.ok(batch.picks.every((p)=>typeof p.selectionId==='string'))
 const pick=batch.picks.find((p)=>p.selectionSource==='discovery')
 assert.ok(pick, '应有探索歌曲')
 const body={sessionId:session.id,trackId:pick.id,selectionId:pick.selectionId,playInstanceId:'auto-1'}
 await call('plays/start',body);await call('plays/start',body)
 assert.deepEqual((await call('plays/history')).automatic,[{track_id:pick.id,selection_source:'discovery'}])
})
test('自动播放窗口跨会话只保留最近 50 次，手动歌曲、待播与重复通知不改变比例', async()=>{
 musicFixture('window')
 let {session}=await call('session/start',{})
 const batch=await call('queue/refill',{sessionId:session.id,epoch:2,count:4})
 const library=batch.picks.find((p)=>p.selectionSource==='library'), discovery=batch.picks.find((p)=>p.selectionSource==='discovery')
 assert.ok(library && discovery, '应同时有歌单与探索歌曲')
 for(let i=0;i<52;i++) {
  const p=i<2?discovery:(i%2?library:discovery)
  await call('plays/start',{trackId:p.id,selectionId:p.selectionId,sessionId:session.id,playInstanceId:'window-'+i})
 }
 await call('session/stop',{});({session}=await call('session/start',{}))
 await call('plays/start',{trackId:999,sessionId:session.id,playInstanceId:'manual-window'})
 const history=(await call('plays/history')).automatic
 assert.equal(history.length,50)
 assert.equal(history.filter((p)=>p.selection_source==='discovery').length,25)
 await app.close();app=await NestFactory.create(AppModule,{logger:false});await app.listen(0,'127.0.0.1');base=await app.getUrl()
 assert.deepEqual((await call('plays/history')).automatic,history)
})
test('不喜欢为具体版本硬排除，撤销后恢复；喜欢用于相似歌曲种子',async()=>{
 musicFixture('feedback')
 const seeds: number[]=[];upstream.simi_song=async({id}: Record<string, unknown>)=>{seeds.push(Number(id));return {body:{code:200,songs:[11,12,13,14].map(song)}}}
 await call('feedback',{trackId:11,sentiment:'dislike'})
 await call('feedback',{trackId:500,sentiment:'like'})
 const {session}=await call('session/start',{})
 const body={sessionId:session.id,epoch:3,count:10}
 const batch=await call('queue/refill',body)
 assert.ok(batch.picks.every((p)=>p.id!==11));assert.ok(seeds.includes(500))
 assert.ok(batch.picks.some((p)=>p.id===12))
 await fetch(base+'/api/feedback/11',{method:'DELETE'})
 const next=await call('queue/refill',{...body,epoch:4})
 assert.ok(next.picks.some((p)=>p.id===11))
})
test('歌单分页不完整且没有完整记录时暂停探索并说明原因',async()=>{
 musicFixture('partial')
 upstream.playlist_detail=async()=>({body:{code:200,playlist:{trackCount:10,trackIds:[{id:3}]}}})
 upstream.playlist_track_all=async()=>({body:{code:200,songs:[song(3)]}})
 const {session}=await call('session/start',{})
 const batch=await call('queue/refill',{sessionId:session.id,epoch:5,count:4})
 assert.equal(batch.ok,true);assert.ok(batch.picks.every((p)=>p.selectionSource==='library'))
 assert.match(batch.message,/未读完整/)
})
test('探索来源与 Codex 均失败仍播放歌单内完整音源，不恢复不喜欢曲目',async()=>{
 musicFixture('failure');setCodexMode('quota')
 upstream.recommend_songs=async()=>{throw Error('offline')};upstream.simi_song=async()=>{throw Error('offline')}
 await call('feedback',{trackId:1,sentiment:'dislike'})
 const {session}=await call('session/start',{})
 const batch=await call('queue/refill',{sessionId:session.id,epoch:6,count:4})
 assert.equal(batch.ok,true);assert.ok(batch.picks.every((p)=>p.selectionSource==='library'&&p.id!==1));assert.match(batch.message,/探索/)
})
test('音源只有试听或不可用时明确失败，不伪造可播结果',async()=>{
 musicFixture('trial')
 upstream.song_url_v1=async({id}: Record<string, unknown>)=>({body:{code:200,data:[{id,url:'https://example.com/trial',freeTrialInfo:{end:30}}]}})
 const {session}=await call('session/start',{})
 const batch=await call('queue/refill',{sessionId:session.id,epoch:7,count:4})
 assert.equal(batch.ok,false);assert.equal(batch.code,'no_playable')
})
test('近期歌曲仅在未播候选无法完整播放时放回并提示',async()=>{
 musicFixture('recent')
 const {automatic}=await call('plays/history')
 const recent=automatic.find((p)=>p.selection_source==='discovery')
 assert.ok(recent, '应保留探索播放历史')
 const recentId=recent.track_id
 upstream.song_url_v1=async({id}: Record<string, unknown>)=>({body:{code:200,data:[{id,url:id===recentId?'https://example.com/full':null}]}})
 const {session}=await call('session/start',{})
 const batch=await call('queue/refill',{sessionId:session.id,epoch:8,count:2})
 assert.equal(batch.ok,true);assert.deepEqual(batch.picks.map((p)=>p.id),[recentId]);assert.match(batch.message,/放宽/)
})
test('歌单分页循环或服务端截断不能被当成完整曲库',async()=>{
 musicFixture('pages')
 upstream.user_playlist=async()=>({body:{code:200,more:true,playlist:Array.from({length:50},(_,i)=>({id:100+i,name:'测试歌单'+i,userId:1,trackCount:2}))}})
 const {session}=await call('session/start',{})
 const batch=await call('queue/refill',{sessionId:session.id,epoch:9,count:2})
 assert.ok(batch.picks.every((p)=>p.selectionSource==='library'));assert.match(batch.message,/未读完整/)
})
test('上游缺少红心或歌单数组不能当作完整空资料',async()=>{
 musicFixture('malformed')
 upstream.likelist=async()=>({body:{code:200}})
 upstream.user_playlist=async()=>({body:{code:200}})
 const {session}=await call('session/start',{})
 const batch=await call('queue/refill',{sessionId:session.id,epoch:10,count:2})
 assert.equal(batch.ok,false);assert.equal(batch.code,'candidates_exhausted')
})
test('有探索候选但全为试听时，返回歌单内歌曲并明确说明原因',async()=>{
 musicFixture('discovery-trial');await call('session/stop',{})
 upstream.song_url_v1=async({id}: Record<string, unknown>)=>({body:{code:200,data:[{id,url:'https://example.com/'+id,freeTrialInfo:Number(id)>=11?{end:30}:null}]}})
 const {session}=await call('session/start',{})
 const batch=await call('queue/refill',{sessionId:session.id,epoch:1,count:4})
 assert.equal(batch.ok,true);assert.equal(batch.degraded,true)
 assert.ok(batch.picks.every((p)=>p.selectionSource==='library'));assert.match(batch.message,/探索候选没有取得完整可播音源/)
})
test('后台补歌以后，显式选歌接口仍可接受新的编排代次',async()=>{
 musicFixture('plan')
 const result=await call('plan',{epoch:2,count:4,brief:'安静'})
 assert.equal(result.ok,true);assert.equal(result.picks.length,4)
 assert.ok(result.picks.some((p)=>p.selectionSource==='discovery'))
})
test('探索连续超时仍保留歌单内兜底的查询预算',async t=>{
 musicFixture('budget-seed')
 const prepared=await call('plan',{epoch:3,count:4})
 const library=prepared.picks.find((p)=>p.selectionSource==='library')
 assert.ok(library, '应有歌单歌曲')
 for(let i=0;i<50;i++)await call('plays/start',{trackId:library.id,selectionId:library.selectionId,playInstanceId:'budget-'+i})
 musicFixture('budget-timeout')
 let now=Date.now();t.mock.method(Date,'now',()=>now)
 upstream.song_url_v1=async({id}: Record<string, unknown>)=>{if(Number(id)>=11){now+=16000;throw Error('timeout')}return {body:{code:200,data:[{id,url:'https://example.com/full'}]}}}
 const batch=await call('plan',{epoch:4,count:4})
 assert.equal(batch.ok,true);assert.ok(batch.picks.some((p)=>p.selectionSource==='library'));assert.match(batch.message,/探索/)
})
