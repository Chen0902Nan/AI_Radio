/* 扫码登录页：只在用户本人操作时使用，凭据由服务端保存。 */
const qrImg = document.getElementById('qr')
const statusEl = document.getElementById('status')
const refreshBtn = document.getElementById('refresh')

let key = null
let pollTimer = null
let expireTimer = null

function stop() {
  clearInterval(pollTimer)
  clearTimeout(expireTimer)
}

async function start(reason) {
  stop()
  qrImg.removeAttribute('src')
  statusEl.textContent = reason ? reason + '，正在获取新二维码…' : '正在获取二维码…'
  try {
    const res = await fetch('/api/login/qr')
    const data = await res.json()
    key = data.key
    qrImg.src = data.qrimg
    statusEl.textContent = '请用网易云音乐 App 扫码，并在手机上确认登录。'
    pollTimer = setInterval(poll, 2500)
    // 网易二维码约 5 分钟失效；提前换一张，避免扫到过期码。
    expireTimer = setTimeout(() => start('二维码即将过期'), 4 * 60 * 1000)
  } catch (err) {
    statusEl.textContent = '获取二维码失败：' + err.message
  }
}

async function poll() {
  if (!key) return
  try {
    const res = await fetch('/api/login/poll?key=' + encodeURIComponent(key))
    const data = await res.json()
    if (data.code === 800) {
      start('二维码已过期')
      return
    }
    if (data.code === 802) {
      statusEl.textContent = '已扫码，请在手机上确认。'
      return
    }
    if (data.code === 803) {
      stop()
      statusEl.textContent = `登录成功：${data.account ? data.account.nickname : ''}，3 秒后返回播放器…`
      setTimeout(() => (location.href = '/'), 3000)
    }
  } catch (_) {
    /* 轮询失败继续重试 */
  }
}

refreshBtn.onclick = () => start('手动刷新')

start()
