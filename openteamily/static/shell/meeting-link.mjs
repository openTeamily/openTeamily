const CODE = /^[A-Za-z0-9_-]{24}$/;

export function meetingCodeFromHash(hash) {
  const code = new URLSearchParams(hash?.slice(1)).get('meeting');
  return typeof code === 'string' && CODE.test(code) ? code : '';
}

export function meetingHref(code) {
  return typeof code === 'string' && CODE.test(code) ? '/chat#meeting=' + code : '';
}

export function parseMeetingCode(value, origin) {
  const input = value.trim();
  if (CODE.test(input)) return input;
  try {
    const url = new URL(input, origin);
    return url.origin === origin && /^\/chat\/?$/.test(url.pathname) ? meetingCodeFromHash(url.hash) : '';
  } catch { return ''; }
}

const CHAT_DRAFT = 'openteamily.meeting-draft-from-chat';

export function stageMeetingFromChat(storage, draft) {
  storage.setItem(CHAT_DRAFT, JSON.stringify(draft));
  return '/meetings#' + new URLSearchParams({workspace: draft.workspace, new: '1', from: 'chat'});
}

export function takeMeetingFromChat(storage, owner, workspace) {
  try {
    const raw = storage.getItem(CHAT_DRAFT);
    storage.removeItem(CHAT_DRAFT);
    const draft = JSON.parse(raw);
    if (draft?.owner === owner && draft.workspace === workspace
      && typeof draft.title === 'string' && draft.title.length <= 120
      && typeof draft.transcript === 'string' && draft.transcript.trim() && draft.transcript.length <= 40000) {
      return draft;
    }
  } catch {}
  return null;
}
