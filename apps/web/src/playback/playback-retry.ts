/** 延迟失败恢复只保留一个计时器；执行前仍由控制器确认播放意图。 */
export class PlaybackRetry {
  private timer: ReturnType<typeof setTimeout> | null = null
  schedule(action: () => void): void {
    this.cancel()
    this.timer = setTimeout(() => { this.timer = null; action() }, 1200)
  }
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
