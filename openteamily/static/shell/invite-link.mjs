// Chat invite links. Self-written for OpenTeamily; the invite table and the
// accept route already exist (openteamily/invites.py), this only builds the
// address a person can paste and reads it back on the members page.

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

export function inviteLink(origin, token) {
  const base = String(origin || '').replace(/\/+$/, '');
  const value = String(token || '').trim();
  if (!base || !TOKEN.test(value)) return '';
  return `${base}/members#invite=${value}`;
}

export function inviteTokenFromHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return '';
  const token = (new URLSearchParams(raw).get('invite') || '').trim();
  return TOKEN.test(token) ? token : '';
}

export async function copyInviteText(text, clipboard) {
  const value = String(text || '').trim();
  if (!value || !clipboard || typeof clipboard.writeText !== 'function') return false;
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function acceptOutcome(status, body) {
  const response = body || {};
  if (status === 202 || (response.join_request && response.join_request.status === 'pending')) return 'pending';
  if (status === 201) return 'joined';
  if (status === 200) return 'already';
  return '';
}
