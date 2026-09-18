/**
 * 收听会话协调（Listening）：停止会话时统一作废准备与 DJ 任务。
 * 底层模块不反向依赖本模块；Controller 调用本服务完成跨模块收尾。
 */
import { Injectable } from '@nestjs/common'
import { OrchestratorService } from '../preparation/orchestrator.service'
import { DjPipelineService } from '../dj/dj-pipeline.service'
import { DbService } from '../persistence/db.service'

@Injectable()
export class ListeningService {
  constructor(
    private readonly db: DbService,
    private readonly orchestrator: OrchestratorService,
    private readonly djPipeline: DjPipelineService,
  ) {}

  /** 停止收听：结束会话并作废该会话的补歌与 DJ 在途任务。 */
  stopSession(): Record<string, unknown> {
    const open = this.db.getOpenSession()
    const ended = this.db.endSession('stopped')
    // 停止后旧补歌结果必须作废，不能污染下一次会话
    if (open) this.orchestrator.invalidateSession(open.id as string)
    // DJ 准备任务同样随会话失效
    if (open) this.djPipeline.invalidateSession(open.id as string)
    return { ok: true, ...ended }
  }
}
