/**
 * MP3 时长解析（迁移自 server/mp3-duration.js）：从音频字节里取得「可取得的时长」。
 * 支持带 Xing/Info 头的 VBR、CBR 估算、ID3v2 标签跳过。
 * 解析不出（HTML/JSON/半截数据）返回 null——调用方据此把响应当 bad_audio 拒绝。
 */
const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
// MPEG2/MPEG2.5（LSF）Layer III 是另一张表，不是 MPEG1 表的一半。
const LSF_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
}

interface FrameHeader {
  version: number
  bitrate: number
  sampleRate: number
  samplesPerFrame: number
  mode: number
  frameBytes: number
}

function parseFrameHeader(buf: Buffer, o: number): FrameHeader | null {
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
  const bitrate = (isMpeg1 ? MPEG1_L3_BITRATES[bitrateIdx] : LSF_L3_BITRATES[bitrateIdx])! * 1000
  if (!bitrate) return null
  const sampleRate = rates[sampleIdx]!
  const samplesPerFrame = isMpeg1 ? 1152 : 576
  const k = isMpeg1 ? 144 : 72
  const frameBytes = Math.floor((k * bitrate) / sampleRate) + ((b2 >> 1) & 0x01)
  return { version, bitrate, sampleRate, samplesPerFrame, mode, frameBytes }
}

function xingDuration(buf: Buffer, offset: number, header: FrameHeader): number | null {
  const side = header.version === 3 ? (header.mode === 3 ? 17 : 32) : header.mode === 3 ? 9 : 17
  const xing = offset + 4 + side
  if (xing + 12 > buf.length) return null
  const tag = buf.toString('latin1', xing, xing + 4)
  if (tag !== 'Xing' && tag !== 'Info') return null
  if (!(buf.readUInt32BE(xing + 4) & 0x01)) return null
  const frames = buf.readUInt32BE(xing + 8)
  return frames > 0 ? (frames * header.samplesPerFrame) / header.sampleRate : null
}
function audioOffset(buf: Buffer): number {
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33 || buf.length <= 10) return 0
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f)
  return 10 + size
}

export function mp3Duration(buf: Buffer): number | null {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null
  let o = audioOffset(buf)
  for (;;) {
    while (o < buf.length - 1 && !(buf[o] === 0xff && (buf[o + 1]! & 0xe0) === 0xe0)) o += 1
    if (o > buf.length - 4) return null
    const h = parseFrameHeader(buf, o)
    if (!h) {
      o += 1
      continue
    }
    const duration = xingDuration(buf, o, h)
    if (duration !== null) return duration
    if (h.bitrate > 0) return ((buf.length - o) * 8) / h.bitrate
    return null
  }
}
