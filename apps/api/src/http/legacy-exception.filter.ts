/**
 * 全局异常过滤器：把未捕获异常渲染为旧合同的 500 { code:'server_error', message }，
 * 防止 NestJS 默认异常格式（{ statusCode, message }）悄悄改变接口合同。
 */
import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from '@nestjs/common'
import type { Response } from 'express'

@Catch()
export class LegacyExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>()
    if (res.headersSent) return
    if (exception instanceof HttpException) {
      const body = exception.getResponse() as Record<string, unknown>
      res.status(exception.getStatus()).header('cache-control', 'no-store')
      res.end(JSON.stringify(body))
      return
    }
    res.status(500).header('cache-control', 'no-store').header('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ code: 'server_error', message: String((exception as Error)?.message || exception) }))
  }
}
