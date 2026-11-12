/**
 * 宿主路由的最小安全层。
 *
 * 为什么必须自己做：dsh-host-webserver 只是路由注册表，README 明确
 * 「不提供服务器级认证或来源策略」，每个 route owner 自己实施。
 *
 * 策略：
 *   - 只接受本机回环来源（127/8、::1、mapped 形式）
 *   - 请求带 Origin 时，必须与 Host 头同源（防跨站读/写）
 *   - 请求体有硬上限，避免大 body 拖垮宿主
 *   - 统一 JSON 错误响应，不泄露内部路径
 */

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/

export function isLoopbackReq(req) {
  // 桌面宿主经 IPC/回环代理时 remoteAddress 可能是空，交给 Origin 校验兜底
  const addr = req.socket?.remoteAddress
  if (!addr) return true
  return LOOPBACK.test(addr)
}

export function isSameOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return true              // 非浏览器 / 同源 GET 通常不带 Origin
  const host = req.headers?.host
  if (!host) return false
  try {
    const u = new URL(origin)
    return u.host.toLowerCase() === String(host).toLowerCase()
  } catch {
    return false
  }
}

/**
 * 统一入口守卫。返回 true 表示已拒绝并写好响应。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function guard(req, res) {
  if (!isLoopbackReq(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback only' })
    return true
  }
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-origin rejected' })
    return true
  }
  return false
}

export function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': buf.length,
  })
  res.end(buf)
}

/**
 * 读请求体（带硬上限）。
 * @returns {Promise<Buffer>}
 */
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = (err) => {
      if (done) return
      done = true
      req.removeListener('data', onData)
      reject(err)
    }
    const onData = (c) => {
      size += c.length
      if (size > maxBytes) {
        fail(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    }
    req.on('data', onData)
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', fail)
    req.on('aborted', () => fail(Object.assign(new Error('aborted'), { status: 400 })))
  })
}

/** JSON 请求体，拒绝非 JSON 内容类型 */
export async function readJson(req, maxBytes) {
  const type = String(req.headers?.['content-type'] || '')
  if (!type.includes('application/json')) {
    throw Object.assign(new Error('content-type must be application/json'), { status: 415 })
  }
  const buf = await readBody(req, maxBytes)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 })
  }
}

/** float32 → 16bit PCM WAV（44.1k 单声道） */
export function pcm16ToWav(pcm16, sampleRate) {
  const dataBytes = pcm16.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)          // PCM
  buf.writeUInt16LE(1, 22)          // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  Buffer.from(pcm16.buffer, pcm16.byteOffset, dataBytes).copy(buf, 44)
  return buf
}
