// Idempotent import of per-user data exported by the platform
// (openteamily/dsbot_bundle.py) and delivered into this DS-Bot's volume as
// /data/openteamily/import/<name>.bundle. A bundle carries one feature's rows
// for this user only, each table as a canonical JSON string plus its SHA-256 in
// the manifest. Rows are upserted by primary key using only the columns the
// feature declares, the bundle digest is recorded so a re-delivered bundle is
// a no-op, and the file is removed after a verified import. Bundles for
// features this plugin version does not serve yet are left in place.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const BUNDLE_FORMAT = 'openteamily-dsbot-import'
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.bundle$/
const IDENT = /^[a-z_][a-z0-9_]{0,63}$/
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

// Target binding policy: a bundle carrying instance_id must match this host.
// Missing instance_id is rejected by default (requireInstanceId !== false).
// Only the private-volume boot importer explicitly passes requireInstanceId:false
// so pre-binding v1 files can still be read there; all manager/featurekit/B4
// import paths require the id. Error text matches src/pending-import.js.
function targetOptions(options) {
  if (typeof options === 'string') return { instanceId: options }
  if (!options || typeof options !== 'object') return {}
  return {
    ...options,
    requireInstanceId: options.requireInstanceId ?? (options.allowLegacy === true ? false : true),
  }
}

export function verifyBundleTarget(bundle, options = {}) {
  const { instanceId, requireInstanceId = true } = targetOptions(options)
  const target = bundle?.instance_id
  if (target === undefined || target === null) {
    if (requireInstanceId) throw Object.assign(new Error('import target missing'), { code: 'import-target-missing' })
    return
  }
  if (typeof target !== 'string' || typeof instanceId !== 'string' || !instanceId || target !== instanceId) {
    throw Object.assign(new Error('import target mismatch'), { code: 'import-target-mismatch' })
  }
}

export function verifyBundle(bundle, feature, options = {}) {
  if (!bundle || bundle.format !== BUNDLE_FORMAT || bundle.version !== 1) throw new Error('unsupported bundle format')
  if (bundle.feature !== feature.name) throw new Error('bundle feature mismatch')
  verifyBundleTarget(bundle, options)
  const declared = feature.importTables ?? {}
  const tables = bundle.tables ?? {}
  const manifest = bundle.manifest ?? {}
  const out = {}
  for (const [table, text] of Object.entries(tables)) {
    if (!Object.hasOwn(declared, table)) throw new Error(`table ${table} is not importable`)
    if (typeof text !== 'string' || manifest[table]?.sha256 !== sha256(text)) throw new Error(`table ${table} digest mismatch`)
    const rows = JSON.parse(text)
    if (!Array.isArray(rows) || rows.length !== manifest[table].rows) throw new Error(`table ${table} row count mismatch`)
    out[table] = rows
  }
  return out
}

export function importBundle(store, feature, bundle, digest, paths = {}, options = {}) {
  const tables = verifyBundle(bundle, feature, options)
  // Media objects (and any other side files) are written first: they are
  // content-addressed, and a failed row import must not already be marked done.
  if (typeof feature.afterImport === 'function') feature.afterImport(bundle, { store, ...paths })
  // Upsert by original id without letting a replaced parent cascade-delete
  // children that the same bundle is about to write again.
  store.exec('PRAGMA foreign_keys=OFF')
  try {
    return importRows(store, feature, tables, digest)
  } finally {
    store.exec('PRAGMA foreign_keys=ON')
  }
}

function importRows(store, feature, tables, digest) {
  return store.transaction(() => {
    if (store.get('SELECT 1 AS ok FROM ot_imports WHERE digest=?', digest)) return { skipped: true, rows: 0 }
    let count = 0
    // Import in declared order so parents land before children.
    for (const [table, columns] of Object.entries(feature.importTables)) {
      const rows = tables[table]
      if (!rows) continue
      if (!IDENT.test(table) || columns.some((column) => !IDENT.test(column))) throw new Error('invalid import declaration')
      const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      const statement = store.db.prepare(sql)
      for (const row of rows) {
        statement.run(...columns.map((column) => {
          const value = row[column]
          if (value === undefined) return null
          return value !== null && typeof value === 'object' ? JSON.stringify(value) : value
        }))
        count += 1
      }
    }
    store.run('INSERT INTO ot_imports VALUES(?,?,?,?)', digest, feature.name, count, Math.floor(Date.now() / 1000))
    return { skipped: false, rows: count }
  })
}

// Import pending bundles for one feature; bundles for other features stay put.
export function importBundles({ store, dataDir, feature, instanceId, requireInstanceId = true }) {
  store.exec('CREATE TABLE IF NOT EXISTS ot_imports (digest TEXT PRIMARY KEY, feature TEXT NOT NULL, rows INTEGER NOT NULL, imported INTEGER NOT NULL)')
  const dir = join(dataDir, 'openteamily', 'import')
  let names = []
  try { names = readdirSync(dir).filter((name) => NAME.test(name)).sort() } catch { return [] }
  const results = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      const text = readFileSync(file, 'utf8')
      const bundle = JSON.parse(text)
      if (bundle?.feature !== feature.name) continue
      const result = importBundle(store, feature, bundle, sha256(text), { dataDir, featureDir: join(dataDir, 'openteamily', 'features', feature.name) }, { instanceId, requireInstanceId })
      unlinkSync(file)
      results.push({ name, status: result.skipped ? 'already-imported' : 'imported', rows: result.rows })
    } catch (error) {
      results.push({ name, status: 'rejected', reason: String(error?.message ?? error).slice(0, 200) })
    }
  }
  return results
}
