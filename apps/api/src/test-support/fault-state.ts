/** 仅显式测试模式消费的有限次故障；控制接口和业务入口共享同一份状态。 */
export const testFaults = {
  injectResolveFailures: 0,
  injectAudioFailures: 0,
  forcedRefillError: null as { code: string; message: string; remaining: number } | null,
  forcedRefillPicks: null as { ids: number[]; remaining: number } | null,
}
