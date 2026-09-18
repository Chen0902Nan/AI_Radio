/**
 * 登录与音乐资料控制器：路由合同见 docs/migration/route-contract.md §1/§2。
 * 音频转发不在 Nest 管道内做 JSON 包装，直接操作原始 res 保持 Range/206 语义。
 */
import { Controller, All, Get, Post, Req, Res, Param, Query, HttpCode } from '@nestjs/common'
import type { Request, Response } from 'express'
import { NeteaseService, NotLoggedInError } from './netease.service'
import { sendJson } from '../http/json.util'
import { TEST_HOOKS } from '../config/app-config'
import { testFaults } from '../test-support/fault-state'

@Controller('api')
export class MusicController {
  constructor(private readonly ncm: NeteaseService) {}

  @Get('health')
  async health(@Res() res: Response): Promise<void> {
    const me = await this.ncm.whoami()
    sendJson(res, 200, {
      ok: true,
      loggedIn: Boolean(me),
      account: me,
      testHooks: process.env.RADIO_TEST_HOOKS === '1',
    })
  }

  @Get('login/qr')
  async qr(@Res() res: Response): Promise<void> {
    const qr = await this.ncm.qrCreate()
    sendJson(res, 200, qr)
  }

  @Get('login/poll')
  async poll(@Res() res: Response, @Query('key') key: string): Promise<void> {
    if (!key) return sendJson(res, 400, { code: 400, message: '缺少 key' })
    const r = await this.ncm.qrCheck(key)
    sendJson(res, 200, r)
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res() res: Response): void {
    this.ncm.clearSession()
    sendJson(res, 200, { ok: true })
  }

  @Get('library')
  async library(@Res() res: Response): Promise<void> {
    const session = this.ncm.loadSession()
    if (!session) return sendJson(res, 401, { code: 'NOT_LOGGED_IN', message: '未登录' })
    const uid = (session.profile && (session.profile as Record<string, unknown>).userId as number) || 0
    const ids = await this.ncm.getLikedIds(session.cookie)
    const tracks = await this.ncm.getLikedTracks(session.cookie, ids)
    const playlists = await this.ncm.getUserPlaylists(session.cookie, uid)
    sendJson(res, 200, {
      account: await this.ncm.whoami(),
      liked: { count: tracks.length, tracks },
      playlists,
    })
  }

  @Get('playlist/:id')
  async playlist(@Res() res: Response, @Param('id') id: string): Promise<void> {
    const session = this.ncm.loadSession()
    if (!session) return sendJson(res, 401, { code: 'NOT_LOGGED_IN' })
    const r = await this.ncm.getPlaylistTracks(session.cookie, id)
    sendJson(res, 200, r)
  }

  /** 音源解析：状态码与字段合同同旧服务（含 force 参数与注入开关）。 */
  @Get('resolve/:id')
  async resolve(@Res() res: Response, @Param('id') id: string, @Query('force') force: string): Promise<void> {
    if (TEST_HOOKS && testFaults.injectResolveFailures > 0) {
      testFaults.injectResolveFailures -= 1
      return sendJson(res, 502, { code: 'injected_failure', message: '（测试注入）该曲目音源解析失败' })
    }
    const info = await this.ncm.resolveTrack(id, { force: force === '1' })
    const kindCode = info.kind === 'full' ? 'ok' : info.kind === 'trial' ? 'trial_only' : 'unplayable'
    const kindMessage =
      info.kind === 'full'
        ? ''
        : info.kind === 'trial'
          ? '账号对该曲目只有试听片段权限，跳过'
          : '账号当前无权播放该曲目（或已下架/地区限制）'
    sendJson(res, 200, {
      id: info.id,
      code: kindCode,
      message: kindMessage,
      kind: info.kind,
      identityKind: info.identity === 'anon' ? 'anon' : 'user',
      level: info.level,
      br: info.br,
      fee: info.fee,
      playable: info.kind === 'full',
      cached: info.cached,
      audioUrl: info.kind === 'full' ? `/api/audio/${info.id}` : null,
    })
  }

  /** 音频转发：逐字节保持旧实现行为（Range 透传/206、断开停止上游、no-store）。 */
  @All('audio/:id')
  async audio(@Req() req: Request, @Res() res: Response, @Param('id') id: string): Promise<void> {
    if (TEST_HOOKS && testFaults.injectAudioFailures > 0) {
      testFaults.injectAudioFailures -= 1
      return sendJson(res, 502, { code: 'injected_audio_failure', message: '（测试注入）音频流获取失败' })
    }
    let info
    try {
      info = await this.ncm.resolveTrack(id)
    } catch (err) {
      const code = (err as NotLoggedInError).code
      sendJson(res, code === 'NOT_LOGGED_IN' ? 401 : 502, {
        code: code || 'resolve_error',
        message: (err as Error).message,
      })
      return
    }
    if (info.kind !== 'full') {
      sendJson(res, 409, {
        code: info.kind === 'trial' ? 'trial_only' : 'unplayable',
        message:
          info.kind === 'trial'
            ? '账号对该曲目只有试听片段权限，跳过'
            : '账号当前无权播放该曲目（或已下架/地区限制）',
        fee: info.fee,
      })
      return
    }

    const headers: Record<string, string> = {}
    if (req.headers.range) headers.range = req.headers.range
    headers['user-agent'] =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

    let upstream: globalThis.Response
    try {
      upstream = await fetch(info.url!, { headers, redirect: 'follow' })
    } catch (err) {
      sendJson(res, 502, { code: 'upstream_error', message: String((err as Error).message || err) })
      return
    }

    if (!upstream.ok && upstream.status !== 206) {
      sendJson(res, 502, {
        code: 'upstream_status',
        status: upstream.status,
        message: `音源 CDN 返回 ${upstream.status}`,
      })
      return
    }

    const passHeaders: Record<string, string> = {}
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
      const v = upstream.headers.get(h)
      if (v) passHeaders[h] = v
    }
    passHeaders['cache-control'] = 'no-store'
    res.writeHead(upstream.status, passHeaders)
    if (!upstream.body) {
      res.end()
      return
    }
    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => res.once('drain', r))
        }
      }
    } catch (_) {
      /* 客户端中断播放 */
    }
    res.end()
  }
}
