// GET /api/openteamily/page?path=<page path>: the OpenTeamily pages, served by
// this user's own DS-Bot from the copy bundled into the image at
// <plugin>/pages (openteamily/static at build time). The platform gateway maps
// a browser path such as /chat/ or /shell/app.css onto this route for the
// signed-in owner's runtime only.
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'

export const PAGE_PATH = '/api/openteamily/page'
export const SERVED_BY_HEADER = 'x-openteamily-served-by'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_PATH = 256

// Resolve a browser page path to a file inside pagesDir, or null. Only plain
// segments are accepted: no dot segments, no encoded separators, no hidden files.
export function resolvePagePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH || !raw.startsWith('/')) return null
  if (raw === '/') return ['home', 'index.html']
  const trailing = raw.endsWith('/')
  const parts = raw.slice(1, trailing ? -1 : undefined).split('/')
  if (parts.some((part) => !SEGMENT.test(part) || part.includes('..'))) return null
  if (trailing) return [...parts, 'index.html']
  const ext = extname(parts.at(-1)).toLowerCase()
  if (Object.hasOwn(TYPES, ext)) return parts
  // Extensionless paths (/settings, /settings/connectors, /profile/edit) are
  // the section's index.html, matching SettingsPage on the platform. Unknown
  // extensions still 404. The file must exist; a missing index is 404 later.
  if (ext === '') return [parts[0], 'index.html']
  return null
}

const notFound = (identity) => new Response('not found', {
  status: 404,
  headers: { 'content-type': 'text/plain; charset=utf-8', [SERVED_BY_HEADER]: `ds-bot; instance=${identity.instanceId}` },
})

export function markHtml(text, identity) {
  const meta = `<meta name="openteamily-served-by" content="ds-bot">`
    + `<meta name="openteamily-instance" content="${identity.instanceId}">`
  return /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, (head) => head + meta) : meta + text
}

export function createPageHandler({ pagesDir, identity }) {
  let root
  return async (request) => {
    const url = new URL(request.url)
    const parts = resolvePagePath(url.searchParams.get('path'))
    if (!parts) return notFound(identity)
    try {
      root ??= await realpath(pagesDir)
      const file = await realpath(join(root, ...parts))
      if (!file.startsWith(root + sep)) return notFound(identity)
      if (!(await stat(file)).isFile()) return notFound(identity)
      const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
      const headers = {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
        [SERVED_BY_HEADER]: `ds-bot; instance=${identity.instanceId}`,
      }
      if (type.startsWith('text/html')) {
        headers['x-frame-options'] = 'DENY'
        if (parts[0] === 'meetings' && parts[1] === 'index.html') {
          headers['permissions-policy'] = 'camera=(), microphone=(self), geolocation=()'
        }
        return new Response(markHtml(await readFile(file, 'utf8'), identity), { status: 200, headers })
      }
      return new Response(await readFile(file), { status: 200, headers })
    } catch {
      root = undefined
      return notFound(identity)
    }
  }
}
