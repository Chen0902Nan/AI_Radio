/**
 * 兼容旧合同的响应助手：错误体统一 { code, message } / { ok:false, code, message }。
 * 状态码映射与 docs/migration/route-contract.md 一致，不得被框架默认异常格式改变。
 */
import { HttpException, HttpStatus } from '@nestjs/common'
import type { Response } from 'express'

export function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).header('cache-control', 'no-store').header('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body, null, 2))
}

/** 抛出携带旧错误体形状的异常；由全局异常过滤器渲染成 { code, message }。 */
export class ApiError extends HttpException {
  constructor(
    public readonly errorCode: string,
    message: string,
    public readonly statusCode: number,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super({ code: errorCode, message, ...extra }, statusCode)
  }
}

export const STATUS = {
  badRequest: HttpStatus.BAD_REQUEST,
  unauthorized: HttpStatus.UNAUTHORIZED,
  notFound: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  upstream: HttpStatus.BAD_GATEWAY,
  rateLimited: HttpStatus.TOO_MANY_REQUESTS,
  serviceUnavailable: HttpStatus.SERVICE_UNAVAILABLE,
  serverError: HttpStatus.INTERNAL_SERVER_ERROR,
}
