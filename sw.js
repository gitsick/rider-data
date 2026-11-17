/* 骑手数据看板中心 Service Worker（R55，R92 数据新鲜度修订）
 * 策略：
 *  - /assets/*（带 hash 的 JS/CSS）：cache-first —— 发版即换 hash，永久缓存安全
 *  - /data/*（JSON 数据）：network-first —— 日更看板正确性优先，首开即见当日新数据；
 *    断网/超时回退缓存（R69 离线 503 语义保留）。原 stale-while-revalidate 存在「每日首开见昨日旧数」的陈旧窗口
 *  - 页面导航（HTML）：network-first —— 始终优先最新，断网/超时回退缓存
 *  - 带查询串的导航请求（门禁/调试 stamp）直连网络，完全不经过 SW
 * 版本升级：改 VER 即弃用全部旧缓存（R92 → v2；v4：capacity 单文件页不入 C_PAGES；
 * v5/R592：巨页瘦至 585KB 后消除例外，恢复 C_PAGES 写入；R602：巨页退役，capacity.html 为
 * dist 树内 SPA 页，navigate 统一 C_PAGES 通道无豁免）
 */
const VER = 'v6'
const C_ASSETS = `rd-assets-${VER}`
const C_PAGES = `rd-pages-${VER}`
const C_DATA = `rd-data-${VER}`
const KEEP = [C_ASSETS, C_PAGES, C_DATA]

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', e => e.waitUntil((async () => {
  const names = await caches.keys()
  await Promise.all(names.filter(n => !KEEP.includes(n)).map(n => caches.delete(n)))
  /* 容量保护：同版本内多次发版会让 assets 缓存累积旧 hash 文件，超限整体重建（重新预热成本低） */
  const a = await caches.open(C_ASSETS)
  if ((await a.keys()).length > 150) await caches.delete(C_ASSETS)
  await self.clients.claim()
})()))

/* R668：/data/*（非 daily）单飞通道单源 —— 页面预载复用 + 并发合并。
 * ① preloadResponse：page-data-preload 预载请求被 SW 接管时直接复用浏览器已发起的传输，
 *    杜绝「预载 + 应用 fetch」同文件双传输（R-RX6 后实测预载与首屏 fetch 并行在途）；
 * ② DATA_INFLIGHT 合并：同路径并发请求共享同一次网络传输（不同 credentials/mode 的 HTTP
 *    缓存键差异会让 HTTP 层不去重），正文一次性读入 ArrayBuffer 后按消费方分发（Response
 *    body 单次消费限制不再约束多消费方）；全部消费方接入后释放槽位。
 * 304 协商响应（R62 SWR）无正文可缓冲，原样透传（单消费方场景）。
 * R669 宽限期复用：刚从网络取回的完整响应在 DATA_GRACE_MS 内同路径直接复用（不重验）——
 * 应用取数晚于预载完成几毫秒时不再多跑一次 304 往返（移动端 RTT 0.5~1s）；只存 network-first
 * 新鲜成功响应（304/离线回缓存不存），新鲜度语义不变。
 * R518 daily 直连通道不动（带查询串本就绕 SW）。 */
const DATA_INFLIGHT = new Map()
const DATA_GRACE = new Map()
const DATA_GRACE_MS = 10000
async function dataOnce(e) {
  const req = e.request
  let key = req.url
  try { key = new URL(req.url).pathname } catch { /* 保底 URL 串 */ }
  const fromMeta = (meta) => meta instanceof Response
    ? meta
    : new Response(meta.buf.slice(0), { status: meta.status, statusText: meta.statusText, headers: meta.headers })
  const held = DATA_INFLIGHT.get(key)
  if (held) {
    try { return fromMeta(await held) } catch { /* 前序失败：走自己的取数路径 */ }
  }
  const g = DATA_GRACE.get(key)
  if (g && Date.now() - g.t < DATA_GRACE_MS) return fromMeta(g.meta) // R669 宽限期内复用刚完成的新鲜响应
  const p = (async () => {
    try {
      let res = null
      try { res = await e.preloadResponse } catch { /* 预载通道失败 → 常规网络 */ }
      if (!res) res = await fetch(req)
      if (res && res.status === 304) return res // R62 SWR 304 协商：原样透传，页面用缓存正文
      if (!res || !res.ok) throw new Error(`data fetch ${res ? res.status : 'offline'}`)
      const buf = await res.arrayBuffer()
      try {
        const c = await caches.open(C_DATA)
        await c.put(req, new Response(buf.slice(0), { status: res.status, statusText: res.statusText, headers: res.headers }))
      } catch { /* 缓存写失败不影响响应 */ }
      const meta = { status: res.status, statusText: res.statusText, headers: res.headers, buf }
      if (DATA_GRACE.size > 8) DATA_GRACE.delete(DATA_GRACE.keys().next().value) // 容量保护
      DATA_GRACE.set(key, { t: Date.now(), meta }) // R669：仅网络新鲜成功响应入宽限期
      return meta
    } catch (err) {
      /* R69 离线回退语义保留：有缓存回缓存，无缓存 503 JSON */
      const c = await caches.open(C_DATA)
      const hit = await c.match(req)
      if (hit) {
        const buf = await hit.arrayBuffer()
        return { status: hit.status, statusText: hit.statusText, headers: hit.headers, buf }
      }
      throw err
    } finally {
      DATA_INFLIGHT.delete(key)
    }
  })()
  DATA_INFLIGHT.set(key, p)
  try {
    return fromMeta(await p)
  } catch {
    /* R69 离线且无缓存：503 JSON 兜底（useData 错误态承接） */
    return new Response('{"error":"offline"}', {
      status: 503, headers: { 'Content-Type': 'application/json' }
    })
  }
}

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET') return
  let url
  try { url = new URL(req.url) } catch { return }
  if (url.origin !== location.origin) return

  /* 门禁/调试：带查询串的页面请求直连网络，不读写缓存（避免 stamp 校验读到旧行） */
  if (req.mode === 'navigate' && url.search) { e.respondWith(fetch(req)); return }
  if (url.search) return

  if (url.pathname.includes('/assets/')) {
    e.respondWith(caches.open(C_ASSETS).then(async c => {
      const hit = await c.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res && res.ok) c.put(req, res.clone())
      return res
    }))
    return
  }

  if (url.pathname.includes('/data/')) {
    /* R92：network-first —— 日更看板首开即见当日新数据；离线回缓存，无缓存时 503 JSON（R69 语义）
     * R518 skip-daily-cache：/data/daily/* 为按需懒载大件（单月数 MB），不写入 SW 缓存，避免「全量区间」一次拖垮 Cache Storage */
    if (url.pathname.includes('/data/daily/')) { e.respondWith(fetch(req)); return }
    e.respondWith(dataOnce(e))
    return
  }

  if (req.mode === 'navigate') {
    /* R602：capacity.html 为 dist 树内 SPA 页（巨页退役），与主站 HTML 统一走
     * C_PAGES（network-first 取最新后写入，离线回退可用）；日更数据 JSON 走上方 /data/*
     * network-first 通道，缓存不滞留旧数据。 */
    e.respondWith((async () => {
      try {
        const res = await fetch(req)
        if (res && res.ok) {
          const c = await caches.open(C_PAGES)
          c.put(req, res.clone())
        }
        return res
      } catch {
        const hit = await caches.match(req)
        if (hit) return hit
        return new Response('离线且无缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }
    })())
  }
})
