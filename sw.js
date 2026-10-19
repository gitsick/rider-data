/* 骑手数据看板中心 Service Worker（R55，R92 数据新鲜度修订）
 * 策略：
 *  - /assets/*（带 hash 的 JS/CSS）：cache-first —— 发版即换 hash，永久缓存安全
 *  - /data/*（JSON 数据）：network-first —— 日更看板正确性优先，首开即见当日新数据；
 *    断网/超时回退缓存（R69 离线 503 语义保留）。原 stale-while-revalidate 存在「每日首开见昨日旧数」的陈旧窗口
 *  - 页面导航（HTML）：network-first —— 始终优先最新，断网/超时回退缓存
 *  - 带查询串的导航请求（门禁/调试 stamp）直连网络，完全不经过 SW
 * 版本升级：改 VER 即弃用全部旧缓存（R92 → v2，同步数据策略变更）
 */
const VER = 'v2'
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
    /* R92：network-first —— 日更看板首开即见当日新数据；离线回缓存，无缓存时 503 JSON（R69 语义） */
    e.respondWith((async () => {
      const c = await caches.open(C_DATA)
      try {
        const res = await fetch(req)
        if (res && res.ok) c.put(req, res.clone())
        return res
      } catch {
        const hit = await c.match(req)
        if (hit) return hit
        return new Response('{"error":"offline"}', {
          status: 503, headers: { 'Content-Type': 'application/json' }
        })
      }
    })())
    return
  }

  if (req.mode === 'navigate') {
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
