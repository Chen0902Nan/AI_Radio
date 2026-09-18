const test=require('node:test'),assert=require('node:assert/strict')
process.env.RADIO_TEST_HOOKS='1'
const {TestHooksController}=require('../../apps/api/dist/test-support/test-hooks.controller.js')
const {MusicController}=require('../../apps/api/dist/music/music.controller.js')
const {PreparationController}=require('../../apps/api/dist/preparation/preparation.controller.js')
const {StaticController}=require('../../apps/api/dist/http/static.controller.js')
const {Writable}=require('node:stream')
function response(){const r=new Writable({write(chunk: any,encoding: any,done: () => void){r.body+=chunk;done()}});r.body='';r.headers={};r.status=(n: any)=>(r.statusCode=n,r);r.header=(k: string|number,v: any)=>(r.headers[k]=v,r);r.writeHead=(n: any,h: any)=>(r.statusCode=n,Object.assign(r.headers,h),r);return r}
function hooks(){return new TestHooksController({}, {}, {})}

test('fail-next只令下一次音源解析失败，消费后恢复正常',async()=>{
 const h=hooks();h.failNext(response(),{count:1})
 const music=new MusicController({resolveTrack:async (id: any)=>({kind:'full',id})})
 const first=response();await music.resolve(first,'123','');assert.equal(first.statusCode,502)
 const second=response();await music.resolve(second,'123','');assert.equal(second.statusCode,200);assert.equal(JSON.parse(second.body).playable,true)
})

test('fail-audio-next令音频流失败一次，之后恢复音源实际结果',async()=>{
 hooks().failAudioNext(response(),{count:1})
 const music=new MusicController({resolveTrack:async()=>({kind:'unplayable'})})
 const a=response();await music.audio({headers:{}},a,'1');assert.equal(a.statusCode,502);assert.equal(JSON.parse(a.body).code,'injected_audio_failure')
 const b=response();await music.audio({headers:{}},b,'1');assert.equal(b.statusCode,409)
})

test('强制补歌失败返回指定错误且只消费配置次数',async()=>{
 hooks().refillForced(response(),{count:1,code:'candidates_exhausted',message:'候选耗尽'})
 const controller=new PreparationController({loadSession:()=>null},{},{},{})
 const a=response();await controller.refill(a,{});assert.equal(a.statusCode,409);assert.equal(JSON.parse(a.body).code,'candidates_exhausted')
 const b=response();await controller.refill(b,{});assert.equal(b.statusCode,401)
})

test('强制补歌曲目经过可播性检查且只影响指定批次',async()=>{
 hooks().refillForcedPicks(response(),{count:1,ids:[11,12]})
 const ncm={loadSession:(): {cookie: string} | null =>({cookie:'fixture'}),currentIdentity:()=> 'forced-fixture',selectionLibrary:async()=>({complete:true,tracks:[{id:11,name:'曲11'},{id:12,name:'曲12'}]}),getLikedIds:async()=>[11,12],getLikedTracks:async()=>[{id:11,name:'曲11'},{id:12,name:'曲12'}]}
 const {OrchestratorService}=require('../../apps/api/dist/preparation/orchestrator.service.js')
 const orchestrator=new OrchestratorService({resolveTrack:async (id: number)=>({kind:id===11?'full':'unplayable'})},{},{getNumberSetting:()=>5},{publish(){}})
 const controller=new PreparationController(ncm,{},orchestrator,{getNumberSetting:()=>5})
 const a=response();await controller.refill(a,{sessionId:'s',epoch:1})
 assert.equal(a.statusCode,200);assert.deepEqual(JSON.parse(a.body).picks.map((p: { id: any })=>p.id),[11]);assert.equal(JSON.parse(a.body).source,'forced')
 // 下一次走正常路径；这里以未登录作为独立可观察结果。
 ncm.loadSession=()=>null;const b=response();await controller.refill(b,{});assert.equal(b.statusCode,401)
})

test('未知API保持404，网页深链接仍返回React页面',async()=>{
 const controller=new StaticController()
 const a=response();controller.serve({path:'/api/does-not-exist',method:'GET'},a);assert.equal(a.statusCode,404)
 const b=response();controller.serve({path:'/login',method:'GET'},b);assert.equal(b.statusCode,200)
 await new Promise(resolve=>b.on('finish',resolve));assert.ok(b.body.includes('id="root"'))
})
