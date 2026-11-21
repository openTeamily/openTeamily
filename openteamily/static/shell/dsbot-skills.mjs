// Materialize the user's effective private-chat skill set in their own DS-Bot.
// Mirrors skill_packages.material for the personal agent: account-scope bindings whose
// version and digest still match the catalogue, plus bundled skills in the user's
// library. The catalogue stays the platform's registry; execution is in DS-Bot.
export function effectiveSkills(catalogue = [], bindings = [], installed = []) {
  const byId = new Map(catalogue.map(item => [item.id, item]));
  const result = new Map();
  for (const binding of bindings) {
    if (binding.scope !== 'account' || binding.enabled === false) continue;
    const item = byId.get(binding.skill_id);
    if (item && item.version === binding.version && item.digest === binding.digest) result.set(item.id, item);
  }
  for (const id of installed) {
    const item = byId.get(id);
    if (item && item.source === 'bundled-original') result.set(item.id, item);
  }
  return [...result.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(({id, name, version, digest, content}) => ({id, name, version, digest, content}));
}

export async function syncSkillsToDsBot(fetcher, headers = {}, api = '/b/api/openteamily') {
  const get = async path => {
    const response = await fetcher(path, {method: 'GET', credentials: 'same-origin', headers: {Accept: 'application/json', ...headers}});
    if (response.status !== 200) throw new Error('skills unavailable');
    return response.json();
  };
  const [catalogue, bindings, installed] = await Promise.all([get('/v1/skills/catalog'), get('/v1/skills/bindings'), get('/v1/skills/installed')]);
  const items = effectiveSkills(catalogue.items || [], bindings.items || [], installed.installed || []);
  const response = await fetcher(api, {method: 'POST', credentials: 'same-origin',
    headers: {...headers, 'Content-Type': 'application/json', Accept: 'application/json'},
    body: JSON.stringify({endpoint: 'skills/sync', payload: {items}})});
  const parsed = await response.json().catch(() => ({}));
  if (response.status !== 200 || !parsed.ok) throw new Error('skills sync failed');
  return parsed.value;
}
