const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const INDEX = /^[0-4]$/;
const VERSION = /^[a-f0-9]{64}$/;
const ALLOWED = new Set(['public-agent', 'quick-start', 'quick-start-version']);

export function publicAgentIntentFromHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const slug = params.get('public-agent');
  if (!SLUG.test(slug || '') || [...params.keys()].some(key => !ALLOWED.has(key) || params.getAll(key).length !== 1)) return null;
  const index = params.get('quick-start');
  const version = params.get('quick-start-version');
  if (index === null && version === null) return {slug};
  if (!INDEX.test(index || '') || !VERSION.test(version || '')) return null;
  return {slug, quickStart: Number(index), version};
}

export function publicAgentContinuation(intent) {
  if (!intent || !SLUG.test(intent.slug || '')) return '';
  const params = new URLSearchParams({'public-agent': intent.slug});
  if (intent.quickStart !== undefined) {
    if (!Number.isInteger(intent.quickStart) || !INDEX.test(String(intent.quickStart)) || !VERSION.test(intent.version || '')) return '';
    params.set('quick-start', String(intent.quickStart));
    params.set('quick-start-version', intent.version);
  }
  return '#' + params;
}
