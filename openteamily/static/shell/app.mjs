/* Shared FlyBot management shell. Enhances chrome only; does not invent
   data, hide functional notes, or replace page APIs or form IDs. */
function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function currentPath() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  return path;
}

function markNavigation() {
  const here = currentPath();
  for (const link of document.querySelectorAll('nav a[href]')) {
    if (link.closest('.catalog-tabs')) continue;
    const href = link.getAttribute('href') || '';
    if (!href.startsWith('/')) continue;
    const target = href.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
    const works = (value) => value === '/space' || value === '/artifacts';
    const inSettings = target === '/settings' && here.startsWith('/settings/');
    if (target === here || inSettings || (works(target) && works(here))) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/* The account stores no location, so「日落到日出」has no sunrise to read. Until one exists, the
   automatic look falls back to a fixed night window: 22:00 inclusive to 06:00 exclusive is dark.
   A `custom` window keeps the times the account chose and stays ahead of this fallback. */
export const NIGHT_WINDOW = {start: '22:00', end: '06:00'};

function minutes(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function resolveTheme(values, now = new Date(), media) {
  const appearance = values && values.appearance ? values.appearance : 'system';
  if (appearance === 'light' || appearance === 'dark') return appearance;
  if (appearance === 'auto') {
    const custom = values.appearance_schedule === 'custom';
    const start = minutes(custom ? values.appearance_start : NIGHT_WINDOW.start);
    const end = minutes(custom ? values.appearance_end : NIGHT_WINDOW.end);
    if (start != null && end != null && start !== end) {
      const current = now.getHours() * 60 + now.getMinutes();
      const inRange = start < end ? current >= start && current < end : current >= start || current < end;
      return inRange ? 'dark' : 'light';
    }
  }
  const query = media || (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);
  return query && query.matches ? 'dark' : 'light';
}

export function applyResolvedTheme(doc, values, now, media) {
  const theme = resolveTheme(values, now, media);
  doc.documentElement.dataset.themeResolved = theme;
  if (doc.body) doc.body.dataset.themeResolved = theme;
  return theme;
}

function looksLoading(text) {
  return /加载|载入|正在|请稍候|等待/.test(text || '');
}

function decorateStatus(node) {
  if (!node) return;
  const text = (node.textContent || '').trim();
  if (!text) {
    node.removeAttribute('data-kind');
    document.body.removeAttribute('aria-busy');
    return;
  }
  if (!node.getAttribute('data-kind') && looksLoading(text)) {
    node.setAttribute('data-kind', 'loading');
  }
  if (node.getAttribute('data-kind') === 'loading' || looksLoading(text)) {
    document.body.setAttribute('aria-busy', 'true');
  } else {
    document.body.removeAttribute('aria-busy');
  }
}

async function loadSettings() {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 3000) : null;
  try {
    const response = await fetch('/v1/settings', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie) },
      signal: controller ? controller.signal : undefined,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const settings = body && body.settings;
    if (!settings) return null;
    return { values: settings.values || {}, revision: settings.revision || 0 };
  } catch (error) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadAppearance() {
  const loaded = await loadSettings();
  return loaded ? loaded.values : null;
}

export function accountNameFromLabel(text, dataset) {
  if (dataset && dataset.username) return String(dataset.username).trim();
  const raw = String(text || '').trim();
  return raw.replace(/^(已登录为|已登录)\s*[:：]?\s*/, '');
}

export function accountInitials(name) {
  const letters = String(name || '').replace(/[^0-9A-Za-z\u4e00-\u9fff]+/g, '');
  return letters ? letters.slice(0, 2).toUpperCase() : '账户';
}


function signedInPanel(doc) {
  return doc.getElementById('settings-panel') || doc.getElementById('main-panel');
}

function closeAccountMenu(doc) {
  const menu = doc.getElementById('account-menu');
  const button = doc.getElementById('account-menu-button');
  const help = doc.getElementById('help-menu');
  const helpButton = doc.getElementById('help-menu-button');
  if (menu) menu.setAttribute('hidden', '');
  if (button) button.setAttribute('aria-expanded', 'false');
  if (help) help.setAttribute('hidden', '');
  if (helpButton) helpButton.setAttribute('aria-expanded', 'false');
}

function syncAccountSlot(doc) {
  const slot = doc.querySelector('.account-slot');
  const panel = signedInPanel(doc);
  if (!slot) return;
  const visible = Boolean(panel && !panel.hasAttribute('hidden'));
  if (visible) slot.removeAttribute('hidden');
  else {
    slot.setAttribute('hidden', '');
    closeAccountMenu(doc);
  }
  const who = doc.getElementById('whoami');
  const name = accountNameFromLabel(who ? who.textContent : '', who ? who.dataset : null);
  const identity = doc.getElementById('account-identity');
  if (identity) identity.textContent = name;
  const button = doc.getElementById('account-menu-button');
  if (button) button.textContent = accountInitials(name);
  for (const node of doc.querySelectorAll('.rail-signed-in')) {
    if (visible) node.removeAttribute('hidden');
    else node.setAttribute('hidden', '');
  }
}


export const ONBOARDING_MENU_HREF = '/onboarding';
export const ONBOARDING_MENU_LABEL = '工作背景';
export const ONBOARDING_MENU_TITLE = '打开已有的工作背景页。对照账户菜单写的是「新手引导」，因为第 2 至 4 步尚未接通，入口名称与落点保持一致。';

export const CHANNELS_MENU_HREF = '/settings/channels';
export const CHANNELS_MENU_LABEL = 'Agent 渠道';
export const CHANNELS_MENU_TITLE = '打开已有的 Agent 渠道设置页。对照账户菜单写的是「Teamily Agent 渠道」，这里用本仓已有名称，不复制商标。';

export const CONNECTORS_MENU_HREF = '/settings/connectors';
export const CONNECTORS_MENU_LABEL = '应用连接器';
export const CONNECTORS_MENU_TITLE = '打开已有的应用连接器设置页。连接第三方账号仍未接通，本入口只负责导航。';

function menuChildByHref(menu, href) {
  const children = menu && menu.children ? Array.from(menu.children) : [];
  return children.find((node) => {
    const tag = (node.tagName || '').toLowerCase();
    const value = (node.getAttribute && node.getAttribute('href')) || node.href || '';
    return tag === 'a' && value === href;
  }) || null;
}

function menuChildByClass(menu, className) {
  const children = menu && menu.children ? Array.from(menu.children) : [];
  return children.find((node) => {
    const current = ' ' + (node.className || node.getAttribute && node.getAttribute('class') || '') + ' ';
    return current.includes(' ' + className + ' ');
  }) || null;
}

function ensureMenuLink(doc, menu, href, label, title) {
  let link = menuChildByHref(menu, href);
  if (!link) {
    link = doc.createElement('a');
    menu.appendChild(link);
  }
  link.setAttribute('href', href);
  link.setAttribute('role', 'menuitem');
  link.setAttribute('title', title);
  link.textContent = label;
  return link;
}

function placeMenuLink(menu, link, reference) {
  if (reference && link !== reference) menu.insertBefore(link, reference);
  else menu.appendChild(link);
  return link;
}

/* Recorded Teamily account menu has「新手引导」after 创建团队 and before 帮助.
   Only step 1 exists, so the item uses the destination name 工作背景 and opens /onboarding.
   The function is also used to move an already-present link into that slot. */
export function ensureOnboardingMenuItem(doc) {
  const menu = doc.getElementById('account-menu');
  if (!menu) return null;
  const link = ensureMenuLink(doc, menu, ONBOARDING_MENU_HREF, ONBOARDING_MENU_LABEL, ONBOARDING_MENU_TITLE);
  const reference = menuChildByClass(menu, 'account-sub') || menuChildByHref(menu, '/settings');
  return placeMenuLink(menu, link, reference);
}

/* Recorded Teamily account menu has Agent 渠道 and 应用连接器 after 创建团队
   (and the skipped credit/plan rows) and before 新手引导/帮助. Both pages already
   exist; this only adds navigation. Connector account linking stays unconnected. */
export function ensureChannelsAndConnectorsMenuItems(doc) {
  const menu = doc.getElementById('account-menu');
  if (!menu) return null;
  const channels = ensureMenuLink(doc, menu, CHANNELS_MENU_HREF, CHANNELS_MENU_LABEL, CHANNELS_MENU_TITLE);
  const connectors = ensureMenuLink(doc, menu, CONNECTORS_MENU_HREF, CONNECTORS_MENU_LABEL, CONNECTORS_MENU_TITLE);
  const before = menuChildByHref(menu, ONBOARDING_MENU_HREF)
    || menuChildByClass(menu, 'account-sub')
    || menuChildByHref(menu, '/settings');
  placeMenuLink(menu, connectors, before);
  placeMenuLink(menu, channels, connectors);
  return {channels, connectors};
}

function bindAccountMenu(doc) {
  const button = doc.getElementById('account-menu-button');
  const menu = doc.getElementById('account-menu');
  if (!button || !menu || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', event => {
    event.stopPropagation();
    const open = menu.hasAttribute('hidden');
    if (open) {
      menu.removeAttribute('hidden');
      button.setAttribute('aria-expanded', 'true');
    } else {
      closeAccountMenu(doc);
    }
  });
  doc.addEventListener('click', event => {
    const slot = doc.querySelector('.account-slot');
    if (!slot || slot.hasAttribute('hidden')) return;
    if (slot.contains(event.target)) return;
    closeAccountMenu(doc);
  });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAccountMenu(doc);
  });
  const panel = signedInPanel(doc);
  const who = doc.getElementById('whoami');
  if (typeof MutationObserver === 'function') {
    const sync = () => syncAccountSlot(doc);
    if (panel) new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    if (who) new MutationObserver(sync).observe(who, { childList: true, characterData: true, subtree: true });
  }
  syncAccountSlot(doc);
  ensureOnboardingMenuItem(doc);
  ensureChannelsAndConnectorsMenuItems(doc);
  bindHelpMenu(doc);
  bindAppearanceToggle(doc);
}

function bindHelpMenu(doc) {
  const button = doc.getElementById('help-menu-button');
  const menu = doc.getElementById('help-menu');
  if (!button || !menu || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const open = menu.hasAttribute('hidden');
    if (open) {
      menu.removeAttribute('hidden');
      button.setAttribute('aria-expanded', 'true');
    } else {
      menu.setAttribute('hidden', '');
      button.setAttribute('aria-expanded', 'false');
    }
  });
}

export function syncAppearanceButton(doc, values, now, media) {
  const button = doc.getElementById('appearance-toggle');
  if (!button) return;
  const theme = resolveTheme(values || { appearance: 'system' }, now, media);
  const labels = doc.documentElement?.lang === 'en' ? {light:'Light', dark:'Dark'} : {light:'浅色', dark:'深色'};
  button.textContent = labels[theme];
  button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
}

function bindAppearanceToggle(doc) {
  const button = doc.getElementById('appearance-toggle');
  if (!button || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', async event => {
    event.preventDefault();
    if (button.dataset.busy === '1') return;
    button.dataset.busy = '1';
    try {
      const loaded = await loadSettings();
      if (!loaded) return;
      const current = resolveTheme(loaded.values);
      const next = current === 'dark' ? 'light' : 'dark';
      const response = await fetch('/v1/settings', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfCookie(document.cookie),
        },
        body: JSON.stringify({ revision: loaded.revision, changes: { appearance: next } }),
      });
      if (!response.ok) return;
      const body = await response.json();
      const values = (body && body.settings && body.settings.values) || { ...loaded.values, appearance: next };
      applyResolvedTheme(doc, values);
      syncAppearanceButton(doc, values);
      const form = doc.getElementById('settings-form');
      if (form && form.elements && form.elements.appearance) {
        for (const option of form.querySelectorAll('[name="appearance"]')) {
          option.checked = option.value === next;
        }
      }
    } finally {
      button.dataset.busy = '0';
    }
  });
}

function enhanceChrome() {
  document.body.classList.add('app');
  if (!document.querySelector('.skip-link')) {
    const skip = document.createElement('a');
    skip.className = 'skip-link';
    skip.href = '#main';
    skip.textContent = '跳到主要内容';
    document.body.insertBefore(skip, document.body.firstChild);
  }
  for (const nav of document.querySelectorAll('nav')) {
    if (!nav.getAttribute('aria-label')) nav.setAttribute('aria-label', '管理导航');
  }
  markNavigation();
  decorateStatus(document.getElementById('status'));
  bindAccountMenu(document);
}

function valuesFromDom(doc) {
  const appearance = (doc.body && doc.body.dataset.theme) || 'system';
  const values = { appearance };
  if (appearance === 'auto') {
    values.appearance_schedule = (doc.body && doc.body.dataset.schedule) || 'sunset_sunrise';
    const form = doc.getElementById('settings-form');
    if (form && form.elements) {
      if (form.elements.appearance_start) values.appearance_start = form.elements.appearance_start.value;
      if (form.elements.appearance_end) values.appearance_end = form.elements.appearance_end.value;
    }
  }
  return values;
}

export function startShell(doc = document, options = {}) {
  const target = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const run = async () => {
    enhanceChrome();
    const loaded = options.values !== undefined ? { values: options.values } : await loadSettings();
    const values = (loaded && loaded.values) || { appearance: 'system' };
    applyResolvedTheme(doc, values, options.now, options.media);
    syncAppearanceButton(doc, values, options.now, options.media);
    if (doc.body && typeof MutationObserver === 'function') {
      new MutationObserver(() => {
        if (doc.body && (doc.body.dataset.theme || doc.body.dataset.schedule)) {
          const next = valuesFromDom(doc);
          applyResolvedTheme(doc, next, options.now, options.media);
          syncAppearanceButton(doc, next, options.now, options.media);
        }
      }).observe(doc.body, { attributes: true, attributeFilter: ['data-theme', 'data-schedule'] });
    }
    const status = doc.getElementById('status');
    if (status && typeof MutationObserver === 'function') {
      new MutationObserver(() => decorateStatus(status)).observe(status, {
        childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-kind'],
      });
    }
  };
  if (doc.readyState === 'loading' && target) target.addEventListener('DOMContentLoaded', run);
  else run();
}

if (typeof document !== 'undefined') startShell();
