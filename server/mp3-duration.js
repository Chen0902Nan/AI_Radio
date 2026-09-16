/**
 * MP3 时长解析（任务 03）：从音频字节里取得「可取得的时长」，用于 15–30 秒边界判定。
 *
 * 支持三类输入：
 *  - 带 Xing/Info 头的（VBR）文件：按帧数 × 每帧样本数 / 采样率精确计算；
 *  - CBR 文件：用首个帧头的比特率对文件长度估算；
 *  - 前面带 ID3v2 标签的文件：先跳过标签。
 * 解析不出（HTML/JSON/半截数据）返回 null——调用方据此把响应当 bad_audio 拒绝，
 * 错误正文绝不能被当作成功 MP3 保存。
 */
const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
// MPEG2/MPEG2.5（LSF）Layer III 是另一张表，不是 MPEG1 表的一半：
// 索引 1、2 分别是 8/16，用 MPEG1 表会把 128kbps 读成 224kbps、时长算小到 57%。
const LSF_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
}

function parseFrameHeader(buf, o) {
  if (o + 4 > buf.length) return null
  const b1 = buf[o + 1]
  const b2 = buf[o + 2]
  const b3 = buf[o + 3]
  const version = (b1 >> 3) & 0x03 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
  const layer = (b1 >> 1) & 0x03 // 1=Layer III
  const bitrateIdx = (b2 >> 4) & 0x0f
  const sampleIdx = (b2 >> 2) & 0x03
  const mode = (b3 >> 6) & 0x03 // 3=mono
  if (version === 1 || layer !== 1) return null
  const rates = SAMPLE_RATES[version]
  if (!rates || sampleIdx === 3) return null
  const isMpeg1 = version === 3
  const bitrate = (isMpeg1 ? MPEG1_L3_BITRATES[bitrateIdx] : LSF_L3_BITRATES[bitrateIdx]) * 1000
  if (!bitrate) return null
  const sampleRate = rates[sampleIdx]
  const samplesPerFrame = isMpeg1 ? 1152 : 576
  const k = isMpeg1 ? 144 : 72
  const frameBytes = Math.floor((k * bitrate) / sampleRate) + ((b2 >> 1) & 0x01)
  return { version, bitrate, sampleRate, samplesPerFrame, mode, frameBytes }
}

function mp3Duration(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null
  let o = 0
  // ID3v2（syncsafe size）
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 && buf.length > 10) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
    o = 10 + size
  }
  for (;;) {
    while (o < buf.length - 1 && !(buf[o] === 0xff && (buf[o + 1] & 0xe0) === 0xe0)) o += 1
    if (o > buf.length - 4) return null
    const h = parseFrameHeader(buf, o)
    if (!h) {
      o += 1
      continue
    }
    // Xing/Info 头：位于首帧头 + 侧信息之后（MPEG1: mono 17 / 立体声 32；MPEG2: 9/17）
    const side = h.version === 3 ? (h.mode === 3 ? 17 : 32) : h.mode === 3 ? 9 : 17
    const xing = o + 4 + side
    if (xing + 12 <= buf.length) {
      const tag = buf.toString('latin1', xing, xing + 4)
      if (tag === 'Xing' || tag === 'Info') {
        const flags = buf.readUInt32BE(xing + 4)
        if (flags & 0x01) {
          const frames = buf.readUInt32BE(xing + 8)
          if (frames > 0) return (frames * h.samplesPerFrame) / h.sampleRate
        }
      }
    }
    if (h.bitrate > 0) return ((buf.length - o) * 8) / h.bitrate
    return null
  }
}

module.exports = { mp3Duration }
