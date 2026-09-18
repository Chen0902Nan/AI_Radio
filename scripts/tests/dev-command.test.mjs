import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { moveToTrash } from '../lib/trash.mjs'

test('dev：冷启动先构建，修改后重启，编译失败保留服务，退出清理子进程', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-dev-test-'))
  fs.mkdirSync(path.join(dir, 'src'))
  const source = path.join(dir, 'src/value.txt')
  fs.writeFileSync(source, 'one')
  fs.writeFileSync(path.join(dir, 'build.mjs'), `
    import fs from 'node:fs';
    const value=fs.readFileSync('src/value.txt','utf8');
    if(value==='invalid') process.exit(1);
    fs.writeFileSync('built.txt',value);
  `)
  fs.writeFileSync(path.join(dir, 'service.mjs'), `
    import fs from 'node:fs';
    console.log(process.argv[2]+':'+process.pid+':'+fs.readFileSync('built.txt','utf8'));
    setInterval(()=>{},1000);
  `)
  const runner = pathToFileURL(path.resolve('scripts/lib/dev-runner.mjs')).href
  fs.writeFileSync(path.join(dir, 'entry.mjs'), `
    import {runDev} from ${JSON.stringify(runner)};
    const command=(...args)=>({file:process.execPath,args});
    process.exitCode=await runDev({cwd:process.cwd(),build:[command('build.mjs')],watchPaths:['src'],backend:command('service.mjs','api'),frontend:command('service.mjs','web')});
  `)
  const child = spawn(process.execPath, ['entry.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', exitCode
  child.stdout.on('data', b => { output += b })
  child.stderr.on('data', b => { output += b })
  const done = new Promise(resolve => child.on('exit', code => { exitCode = code; resolve() }))
  t.after(async () => { if (exitCode === undefined) child.kill('SIGTERM'); await done; moveToTrash(dir) })
  async function waitFor(predicate) {
    const until = Date.now() + 6000
    while (!predicate() && Date.now() < until && exitCode === undefined) await new Promise(r => setTimeout(r, 30))
    assert.ok(predicate(), output)
  }
  await waitFor(() => /api:\d+:one/.test(output) && /web:\d+:one/.test(output))
  const first = Number(output.match(/api:(\d+):one/)[1])
  fs.writeFileSync(source, 'two')
  await waitFor(() => /api:\d+:two/.test(output))
  assert.throws(() => process.kill(first, 0), { code: 'ESRCH' })
  const second = Number(output.match(/api:(\d+):two/)[1])
  fs.writeFileSync(source, 'invalid')
  await waitFor(() => output.includes('编译失败'))
  assert.doesNotThrow(() => process.kill(second, 0))
  fs.writeFileSync(source, 'three')
  await waitFor(() => /api:\d+:three/.test(output))
  const last = Number(output.match(/api:(\d+):three/)[1])
  const web = Number(output.match(/web:(\d+):one/)[1])
  child.kill('SIGINT')
  await done
  assert.equal(exitCode, 0, output)
  for (const pid of [second, last, web]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
