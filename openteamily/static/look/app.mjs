// Shared Personal Agent look avatar. The server stores one of these looks in
// onboarding step 4; this module renders it with plain DOM nodes and CSS, not
// user-supplied markup. Values are an explicit allowlist so a corrupt stored
// row cannot inject arbitrary attributes or text.

export const LOOK_FIELDS = ['color', 'expression', 'headwear', 'glasses', 'hand'];

export const LOOK_OPTIONS = {
  color: ['珊瑚橙', '天空蓝', '薄荷绿', '葡萄紫', '柠檬黄', '石墨灰'],
  expression: ['微笑', '专注', '好奇', '酷'],
  headwear: ['无', '棒球帽', '耳机', '贝雷帽'],
  glasses: ['无', '圆框眼镜', '墨镜'],
  hand: ['无', '咖啡杯', '笔记本', '魔法棒'],
};

export function validLook(look) {
  if (!look || typeof look !== 'object' || Array.isArray(look)) return false;
  return LOOK_FIELDS.every((name) => LOOK_OPTIONS[name].includes(look[name]));
}

export function createLookAvatar(look, document) {
  if (!document || !validLook(look)) return null;
  const root = document.createElement('span');
  root.className = 'look-avatar';
  root.setAttribute('aria-hidden', 'true');
  for (const name of LOOK_FIELDS) root.dataset[name] = look[name];
  for (const classes of ['look-portrait', 'look-glasses', 'look-hand']) {
    const node = document.createElement('span');
    node.className = classes;
    root.append(node);
  }
  return root;
}
