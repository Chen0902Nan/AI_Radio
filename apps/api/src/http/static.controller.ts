/**
 * 静态资源控制器：服务 React 构建产物（apps/web/dist）。无扩展名路径映射同名 .html（/login）。
 * （旧 public/ 静态服务已在 M5 清理时随迁移完成退役。）
 */
import { Controller, All, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { projectRoot } from '../config/app-config'
import { sendJson } from './json.util'


function resolveWebRoot(): string {
  return path.join(projectRoot(), 'apps', 'web', 'dist')
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

@Controller()
export class StaticController {
  @All('*')
  serve(@Req() req: Request, @Res() res: Response): void {
    const urlPath = req.path
    if (urlPath === '/api' || urlPath.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method)) {
      return sendJson(res, 404, { code: 'NOT_FOUND', message: '接口不存在' })
    }
    if (urlPath === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    const webRoot = resolveWebRoot()
    // 无扩展名路径（/、/login 等）统一回落 SPA index.html；带扩展名的按文件找
    let file: string
    if (urlPath === '/' || !path.extname(urlPath)) {
      file = path.join(webRoot, 'index.html')
    } else {
      file = path.resolve(webRoot, '.' + urlPath)
    }
    if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const ext = path.extname(file)
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    fs.createReadStream(file).pipe(res)
  }
}
