// Nest bootstrap：统一初始化数据库、收尾旧会话；Controller 导入不得打开数据库。
// .env 由启动脚本 --env-file-if-exists 加载；这里不覆盖已有进程环境变量。
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { LegacyExceptionFilter } from './http/legacy-exception.filter'
import { SERVER, TEST_HOOKS } from './config/app-config'
import { DbService } from './persistence/db.service'
import { NeteaseService } from './music/netease.service'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false })
  app.useGlobalFilters(new LegacyExceptionFilter())

  // 启动收尾：上一条开着但已无心跳的会话不再算进行中（不得让新旧服务同时执行）
  const db = app.get(DbService)
  try {
    const closed = db.closeStaleSessions('server_restart')
    if (closed.closed) console.log(`[radio] 已收尾上次未结束的会话 ${closed.id}`)
  } catch (err) {
    console.error('[radio] 收尾旧会话失败：', (err as Error).message)
  }

  await app.listen(SERVER.port, SERVER.host)
  console.log(`[radio] http://${SERVER.host}:${SERVER.port}`)
  if (TEST_HOOKS) console.log('[radio] 测试注入已启用 (RADIO_TEST_HOOKS=1)')

  const ncm = app.get(NeteaseService)
  try {
    await ncm.init()
    console.log('[radio] 网易云匿名会话已就绪')
  } catch (err) {
    console.error('[radio] 初始化失败:', (err as Error).message)
  }
  const me = await ncm.whoami()
  console.log(
    me ? `[radio] 已登录：${me.nickname} (uid=${me.userId})` : '[radio] 未登录，请打开 /login 扫码',
  )
}

void bootstrap()
