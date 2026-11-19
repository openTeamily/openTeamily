// Self-written capability catalogue. No install/execution backend exists yet.
// Search is real; install controls are deliberately disabled (never fake success).

export const SKILLS = [
  {id: 'meeting-notes', mark: '会', name: '会议纪要', description: '把会议记录整理成结论、待办和负责人。'},
  {id: 'web-summary', mark: '网', name: '网页摘要', description: '提取网页正文并生成一段可读的要点摘要。'},
  {id: 'slide-draft', mark: '演', name: '幻灯片草稿', description: '把一份大纲整理成幻灯片页面和讲解要点。'},
  {id: 'data-brief', mark: '数', name: '数据速览', description: '汇总表格里的关键数字、变化和异常项。'},
  {id: 'email-draft', mark: '邮', name: '邮件起草', description: '根据上下文起草一封语气合适的邮件。'},
  {id: 'doc-rewrite', mark: '文', name: '文档改写', description: '调整文档的语气、长度和段落结构。'},
  {id: 'code-review', mark: '码', name: '代码审阅', description: '标出改动里的风险、边界和遗漏的测试。'},
  {id: 'market-watch', mark: '竞', name: '竞品观察', description: '把公开资料中的产品更新整理成对照清单。'},
  {id: 'trip-plan', mark: '行', name: '行程规划', description: '把时间、地点和预算整理成可执行的行程。'},
  {id: 'know-how', mark: '知', name: '知识检索', description: '在工作区已授权的资料中查找相关答案。'},
];

export function filterSkills(items = SKILLS, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return items.slice();
  return items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(needle));
}

export function skillCountLabel(shown, total) {
  return shown === total ? `共 ${total} 个技能` : `显示 ${shown} / ${total} 个技能`;
}

export function mountSkills(document) {
  const list = document.getElementById('skills-list');
  const input = document.getElementById('skills-search');
  const empty = document.getElementById('skills-empty');
  const count = document.getElementById('skills-count');
  if (!list || !input) return null;

  function render() {
    const matches = filterSkills(SKILLS, input.value);
    list.replaceChildren(...matches.map((skill) => {
      const item = document.createElement('li');
      item.className = 'skill-card';

      const mark = document.createElement('span');
      mark.className = 'skill-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = skill.mark;

      const copy = document.createElement('span');
      copy.className = 'skill-copy';
      const name = document.createElement('strong');
      name.textContent = skill.name;
      const description = document.createElement('span');
      description.className = 'skill-description';
      description.textContent = skill.description;
      copy.append(name, description);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'skill-install';
      button.dataset.skill = skill.id;
      button.disabled = true;
      button.setAttribute('aria-label', `安装 ${skill.name}（未接通）`);
      button.title = '未接通：尚无技能安装、授权及运行时加载接口';
      button.textContent = '未接通';

      item.append(mark, copy, button);
      return item;
    }));
    if (empty) empty.hidden = matches.length > 0;
    if (count) count.textContent = skillCountLabel(matches.length, SKILLS.length);
  }

  input.addEventListener('input', render);
  render();
  return {render};
}

if (typeof document !== 'undefined') mountSkills(document);
