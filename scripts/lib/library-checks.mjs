/**
 * 资料读取报告的判定逻辑。
 *
 * 单独抽出来是为了让“读出来的数据到底算不算通过”有唯一实现：
 * 报告里出现资料缺失、分页不一致、部分查询失败时，必须让脚本以非零退出码结束，
 * 否则 CI 或人只看退出码时会把失败当成成功。
 */

export function collectFailures(report) {
  const failures = []

  if (report.blocked) failures.push(`被阻塞：${report.blocked}`)

  if (report.liked) {
    if (report.liked.idsReturned !== report.liked.idsUnique) {
      failures.push(`红心 id 有重复：${report.liked.idsReturned} 条 → 去重后 ${report.liked.idsUnique}`)
    }
    if (report.liked.missingDetails > 0) {
      failures.push(`红心歌曲详情缺失 ${report.liked.missingDetails} 首`)
    }
    if (report.liked.tracksReturned === 0) failures.push('红心歌曲一首都没读到')
  }

  if (report.pagination && report.pagination.consistent !== true) {
    failures.push('歌单分页结果不一致（不同 pageSize 读出的集合不同）')
  }

  for (const pl of report.playlistTracks || []) {
    if (pl.error) {
      failures.push(`歌单 ${pl.id}「${pl.name}」读取失败：${pl.error}`)
    } else if (pl.complete === false) {
      failures.push(`歌单 ${pl.id}「${pl.name}」曲目不完整：${pl.returned}/${pl.declaredTrackCount}`)
    } else if (pl.returned !== pl.unique) {
      failures.push(`歌单 ${pl.id}「${pl.name}」曲目有重复：${pl.returned} 条 → 去重后 ${pl.unique}`)
    }
  }

  if (report.playability) {
    const d = report.playability.distribution || {}
    if (d.error > 0) failures.push(`音源查询报错 ${d.error} 首`)
    if (!d.full) failures.push('抽样的红心歌曲里没有一首可完整播放')
  }

  for (const step of report.steps || []) {
    if (step.ok === false) failures.push(`步骤 ${step.step} 失败${step.error ? '：' + step.error : ''}`)
  }

  return [...new Set(failures)]
}
