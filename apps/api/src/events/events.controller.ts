/**
 * SSE 路由：GET /api/events。消息只含状态通知；无会话/任务的过期消息由客户端忽略。
 * 响应排除压缩/缓冲：text/event-stream 直通。
 */
import { Controller, Get, Sse, MessageEvent, Res, Header } from '@nestjs/common'
import type { Observable } from 'rxjs'
import type { Response } from 'express'
import { EventsService } from './events.service'

@Controller('api')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Sse('events')
  @Header('cache-control', 'no-store')
  @Header('x-accel-buffering', 'no')
  events$(): Observable<MessageEvent> {
    return this.eventsService.stream()
  }

  /** 连接诊断（测试钩子使用）：当前连接数与序号。 */
  @Get('events/_diag')
  diag(@Res() res: Response): void {
    res.status(200).header('content-type', 'application/json; charset=utf-8').end(
      JSON.stringify({ ok: true, connections: this.eventsService.connectionCount(), seq: this.eventsService.currentSeq() }),
    )
  }
}
