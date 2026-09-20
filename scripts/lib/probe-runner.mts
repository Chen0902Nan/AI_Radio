import { withVerification, type VerificationEnvironment } from './verification-environment.mts'
export interface Check { name: string; ok: boolean; detail?: unknown }
export interface ProbeContext { env: VerificationEnvironment; check(name: string, ok: unknown, detail?: unknown): void }
export async function runProbe(name: string, run: (ctx: ProbeContext) => Promise<void>, args = process.argv.slice(2)): Promise<void> {
  await withVerification(name, args, async env => {
    const checks: Check[] = []
    let fatal: string | undefined
    const check = (name: string, ok: unknown, detail?: unknown) => {
      checks.push({ name, ok: Boolean(ok), detail })
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
      if (!ok) throw new Error(`验证失败：${name}`)
    }
    try { await run({ env, check }) }
    catch (error) { fatal = error instanceof Error ? error.message : String(error); throw error }
    finally {
      const output = env.writeReport({ at: new Date().toISOString(), mode: env.fixture ? 'local-provider-fixtures' : 'real-providers', checks, fatal, passed: !fatal && checks.every(c => c.ok) })
      console.log(`报告：${output}`)
    }
  })
}
export function failed(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1
}
