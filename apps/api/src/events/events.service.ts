/**
 * SSE 状态通知（M4）：只通知服务端准备任务和配置状态，不发强制播放命令，
 * 不成为队列事实来源（ADR-0003）。
 *
 * 消息合同：
 *  - { v: 协议版本, seq: 单调序号, type, sessionId?, epoch?, ...任务身份 }
 *  - 客户端按 (type, 任务身份) 幂等去重；重复/乱序事件不改变播放语义。
 *  - 无持久事件重放：重连 = 拉快照（GET /api/session 等）+ 订阅后续事件。
 */
import { Injectable } from '@nestjs/common'
import { Subject, Observable, map, finalize } from 'rxjs'

export const SSE_PROTOCOL_VERSION = 1

export type SseEventType =
  | 'refill-status' // 补歌任务状态变化（在途开始/结束、降级、失败）
  | 'dj-status' // DJ 准备任务状态变化（preparing/ready/unavailable/stale）
  | 'config-changed' // 设置/语音配置更新

export interface SseMessage {
  type: SseEventType
  sessionId?: string | null
  epoch?: number
  segueId?: string
  transitionId?: string
  state?: string
  code?: string
  message?: string
  degraded?: boolean
  key?: string
}

interface InternalMessage extends SseMessage {
  seq: number
  v: number
  at: number
}

@Injectable()
export class EventsService {
  private subject = new Subject<InternalMessage>()
  private seq = 0
  /** 有界最近事件缓存（诊断用，不是重放保证） */
  private recent: InternalMessage[] = []
  private readonly RECENT_LIMIT = 100
  private connections = 0

  publish(msg: SseMessage): void {
    this.seq += 1
    const internal: InternalMessage = { ...msg, seq: this.seq, v: SSE_PROTOCOL_VERSION, at: Date.now() }
    this.recent.push(internal)
    if (this.recent.length > this.RECENT_LIMIT) this.recent.shift()
    this.subject.next(internal)
  }

  /** 订阅事件流；连接断开（Observable 终止）自动清理订阅与计数。 */
  stream(): Observable<{ type: 'event'; data: InternalMessage }> {
    this.connections += 1
    return new Observable<InternalMessage>((subscriber) => {
      const sub = this.subject.subscribe(subscriber)
      return () => sub.unsubscribe()
    }).pipe(
      map((data) => ({ type: 'event' as const, data })),
      finalize(() => {
        this.connections -= 1
      }),
    )
  }

  connectionCount(): number {
    return this.connections
  }

  /** 当前序号（客户端诊断重连用；不是 Last-Event-ID 重放承诺）。 */
  currentSeq(): number {
    return this.seq
  }
}
