/* AEEIS 多 Bot 工作室 — interaction demo
   Data is local and static; every action is client-side. */

const TONES = {
  blue:  { bg: '#eef4ff', fg: '#2347d5' },
  cyan:  { bg: '#eefaf8', fg: '#158a83' },
  amber: { bg: '#fff6df', fg: '#8a5a14' },
  red:   { bg: '#fff3f4', fg: '#a33f4b' },
  lime:  { bg: '#f4fbe8', fg: '#5f7d1f' }
};

const BOTS = {
  an: {
    name: '小安', role: 'PM', initial: '安', tone: 'blue',
    status: 'working', current: '拆解发布任务',
    desc: '协调节奏、分派任务、汇总汇报；默认入口 Bot。',
    memory: ['发布窗口偏好周三', '每周一复盘', '对外发送必须先出草稿'],
    perms: [['读频道资料', '允许'], ['分派任务', '允许'], ['提议新 Bot', '需批准']],
    recent: '2 次交接 · 平均 3 分钟'
  },
  yan: {
    name: '阿研', role: '研究', initial: '研', tone: 'cyan',
    status: 'working', current: '评估发布风险 · 62%',
    desc: '资料检索、竞品与风险分析；只读外部页面，不写入。',
    memory: ['供应商只签年付', '发布窗口有两个版本', '风险清单按“可解决 / 需回滚”分组'],
    perms: [['读频道资料', '允许'], ['浏览器', '只读'], ['单任务预算', '20k']],
    recent: '交接给阿写 2 次 · 平均 6 分钟'
  },
  xie: {
    name: '阿写', role: '写作', initial: '写', tone: 'amber',
    status: 'waiting', current: '等待风险清单',
    desc: '把结论写成可读的交付物；不替人做最终判断。',
    memory: ['发布说明先给三行摘要', '不写没有证据的结论'],
    perms: [['读频道资料', '允许'], ['写文档', '允许'], ['对外发送', '需批准']],
    recent: '本周 3 个产物 · 平均 11 分钟'
  },
  he: {
    name: '阿核', role: '审核', initial: '核', tone: 'red',
    status: 'idle', current: '空闲 · 可接审核',
    desc: '核对结论与证据；有权把产物打回“待修改”。',
    memory: ['发布清单必须附变更记录', '置信度低于 70% 要标出'],
    perms: [['读证据', '允许'], ['写审核意见', '允许'], ['打回产物', '允许']],
    recent: '2 次审核 · 1 次打回'
  },
  shu: {
    name: '阿数', role: '数据', initial: '数', tone: 'cyan',
    status: 'working', current: '拉激活漏斗 · 48%',
    desc: '取数、分群、验证口径；不直接改业务表。',
    memory: ['激活口径：创建第一个 Goal', '移动端单独分群'],
    perms: [['读数据仓库', '允许'], ['写分析表', '允许'], ['业务表写入', '禁止']],
    recent: '3 次分析 · 平均 9 分钟'
  },
  shi: {
    name: '阿实', role: '实验', initial: '实', tone: 'lime',
    status: 'idle', current: '空闲 · 可接实验',
    desc: '设计并运行小流量实验；上线前必须有人批准。',
    memory: ['实验最小样本 5k', '先做 5% 流量'],
    perms: [['读数据仓库', '允许'], ['创建实验', '需批准'], ['放量', '需批准']],
    recent: '本周 1 个实验 · 待启动'
  },
  gui: {
    name: '阿归', role: '归类', initial: '归', tone: 'amber',
    status: 'working', current: '聚类 42 条反馈 · 80%',
    desc: '把零散反馈归因、去重、标出高频主题。',
    memory: ['按“首次使用 / 权限 / 导出”三类', '保留原文，不改写'],
    perms: [['读反馈库', '允许'], ['写标签', '允许'], ['外发', '禁止']],
    recent: '42 条 · 17 条同一主题'
  }
};

const STATUS_LABEL = {
  inbox: '待整理', ready: '待领取', working: '进行中',
  blocked: '阻塞', review: '待验收', done: '完成', failed: '失败'
};
const BOT_STATUS_LABEL = {
  working: '执行中', waiting: '等待', blocked: '需要你',
  idle: '空闲', paused: '已暂停', offline: '离线'
};

const CHANNELS = [
  {
    id: 'launch',
    name: '发布协作',
    goal: 'AEEIS 首个可用版本',
    status: '进行中',
    unread: false,
    members: ['an', 'yan', 'xie', 'he'],
    botStates: {
      an: { status: 'working', current: '拆解发布任务' },
      yan: { status: 'working', current: '评估发布风险 · 62%' },
      xie: { status: 'waiting', current: '等待风险清单' },
      he: { status: 'idle', current: '空闲 · 可接审核' }
    },
    tasks: [
      {
        id: 'risk', title: '评估发布风险', status: 'working', owner: 'yan', progress: 62,
        budget: '8k', used: '3.2k', evidence: 4, deps: '发布资料',
        note: '找出 3 个发布阻塞，按“可发布前解决 / 需要回滚预案”分组。',
        deliverable: '风险清单 + 回滚步骤 + 证据',
        evidenceList: ['发布清单', '变更记录', '供应商邮件', '风险评估草稿'],
        steps: [
          { label: '读取发布资料', done: true },
          { label: '核对变更记录', done: true },
          { label: '整理风险清单', done: false, current: true },
          { label: '写回滚步骤', done: false }
        ]
      },
      {
        id: 'checklist', title: '核对发布清单', status: 'review', owner: 'he', progress: 100,
        budget: '2k', used: '1.4k', evidence: 3, deps: '发布资料',
        note: '把发布清单与变更记录逐项对照，标出阻塞。',
        evidenceList: ['发布清单', '变更记录', '供应商邮件'],
        steps: [
          { label: '读取清单', done: true },
          { label: '对照变更记录', done: true },
          { label: '标出 3 个阻塞', done: true }
        ]
      },
      {
        id: 'rollback', title: '写回滚方案', status: 'ready', owner: 'xie', progress: 0,
        budget: '6k', used: '0', evidence: 0, deps: '风险评估',
        note: '按风险清单写可执行的回滚步骤；需要阿研的结论。',
        steps: [
          { label: '等待风险清单', done: false, current: true },
          { label: '写回滚步骤', done: false },
          { label: '提交审核', done: false }
        ]
      },
      {
        id: 'release-notes', title: '整理发布说明', status: 'working', owner: 'xie', progress: 35,
        budget: '4k', used: '1.1k', evidence: 2, deps: '变更记录',
        note: '给内部团队的三行摘要 + 完整变更列表。',
        steps: [
          { label: '整理变更列表', done: true },
          { label: '写三行摘要', done: false, current: true },
          { label: '阿核审核', done: false }
        ]
      },
      {
        id: 'window', title: '确认发布窗口', status: 'blocked', owner: 'an', progress: 20,
        budget: '1k', used: '.2k', evidence: 2, deps: '供应商回执',
        note: '资料里有两个窗口版本，等阿研确认后再排期。',
        steps: [
          { label: '收集窗口信息', done: true },
          { label: '确认周一 / 周三', done: false, current: true }
        ]
      },
      {
        id: 'changelog', title: '核对变更记录', status: 'done', owner: 'yan', progress: 100,
        budget: '2k', used: '1.8k', evidence: 5, deps: '—',
        note: '变更记录与发布清单已对齐。',
        steps: [
          { label: '读取变更记录', done: true },
          { label: '与清单对齐', done: true },
          { label: '标记 3 个阻塞', done: true }
        ]
      }
    ],
    files: [
      { name: '发布清单.pdf', type: 'PDF', meta: '4 页 · 10:01' },
      { name: '变更记录.md', type: 'MD', meta: '12 条 · 09:48' },
      { name: '供应商窗口.txt', type: 'TXT', meta: '2 个版本 · 昨天' }
    ],
    messages: [
      { type: 'system', text: '小安把 3 个任务加入发布协作', time: '10:01' },
      { type: 'human', text: '把这周的发布风险梳理一下，顺便给我回滚方案。', time: '10:02' },
      { type: 'bot', bot: 'an', text: '收到。我拆成三件事：整理发布资料、评估风险、写回滚方案。阿研先做风险，阿写等资料。预计 20 分钟。', time: '10:02' },
      { type: 'handoff', id: 'ho-risk', from: 'an', to: 'yan', task: 'risk', time: '10:03' },
      { type: 'bot', bot: 'yan', text: '我先看资料。需要读取 3 个外部页面，已发审批。', time: '10:04' },
      { type: 'approval', id: 'ap1', task: 'risk', bot: 'yan', time: '10:04' },
      { type: 'question', id: 'q1', task: 'window', bot: 'yan', time: '10:05' },
      { type: 'bot', bot: 'he', text: '发布清单我先核对了：3 个阻塞，2 个能在发布前解决，1 个需要回滚预案。等风险清单出来一起验收。', time: '10:06' },
      { type: 'artifact', id: 'art-checklist', task: 'checklist', bot: 'he', time: '10:07', title: '发布清单已核对', summary: '3 个阻塞：2 个可在发布前解决，1 个需要回滚预案。', evidence: ['发布清单', '变更记录', '供应商邮件'] },
      { type: 'digest', time: '10:08', stats: [['1', '完成'], ['2', '进行中'], ['1', '待领取'], ['1', '阻塞'], ['1', '待验收']] }
    ]
  },
  {
    id: 'growth',
    name: '增长实验',
    goal: '把激活率从 18% 提到 25%',
    status: '进行中',
    unread: true,
    members: ['an', 'shu', 'xie', 'shi'],
    botStates: {
      an: { status: 'working', current: '协调增长实验' },
      shu: { status: 'working', current: '拉激活漏斗 · 48%' },
      xie: { status: 'working', current: '新用户分群对比 · 70%' },
      shi: { status: 'idle', current: '空闲 · 可接实验' }
    },
    tasks: [
      {
        id: 'funnel', title: '激活漏斗归因', status: 'working', owner: 'shu', progress: 48,
        budget: '5k', used: '2.1k', evidence: 3, deps: '—',
        note: '找出 7 日激活漏斗里流失最大的环节，并给出分群证据。',
        deliverable: '归因结论 + 分群证据',
        evidenceList: ['漏斗数据', '分群切片', '会话回放'],
        steps: [
          { label: '取 7 日漏斗', done: true },
          { label: '按端 / 渠道分群', done: true },
          { label: '写归因结论', done: false, current: true }
        ]
      },
      {
        id: 'cohort', title: '新用户分群对比', status: 'working', owner: 'xie', progress: 70,
        budget: '3k', used: '1.9k', evidence: 2, deps: '漏斗数据',
        note: '对比自然流量与投放流量的首个 Goal 创建率。',
        steps: [
          { label: '拉分群', done: true },
          { label: '对齐口径', done: true },
          { label: '写对比页', done: false, current: true }
        ]
      },
      {
        id: 'experiment', title: '实验：引导文案', status: 'ready', owner: 'shi', progress: 0,
        budget: '8k', used: '0', evidence: 0, deps: '归因结论',
        note: '在创建第一个 Goal 的页面做 5% 流量实验。',
        steps: [
          { label: '等待归因结论', done: false, current: true },
          { label: '配置实验', done: false },
          { label: '放量审批', done: false }
        ]
      },
      {
        id: 'weekly', title: '增长周报', status: 'review', owner: 'shu', progress: 100,
        budget: '2k', used: '1.2k', evidence: 4, deps: '—',
        note: '本周激活、留存、实验进展与下周建议。',
        steps: [
          { label: '汇总数据', done: true },
          { label: '写结论', done: true },
          { label: '待你验收', done: false, current: true }
        ]
      },
      {
        id: 'write', title: '回写目标表', status: 'failed', owner: 'xie', progress: 60,
        budget: '1k', used: '.8k', evidence: 2, deps: '—',
        note: '目标表拒绝 2 条记录；已有原始回执，不自动重试。',
        steps: [
          { label: '写入 10 条', done: true },
          { label: '2 条被拒绝', done: true },
          { label: '等待处理', done: false, current: true }
        ]
      }
    ],
    files: [
      { name: '激活漏斗.csv', type: 'CSV', meta: '7 日 · 09:20' },
      { name: '实验计划.md', type: 'MD', meta: '5% 流量 · 昨天' }
    ],
    messages: [
      { type: 'system', text: '小安把「激活漏斗」拆成 3 个任务', time: '09:12' },
      { type: 'human', text: '看一下上周激活漏斗，哪个环节掉得最多？', time: '09:12' },
      { type: 'bot', bot: 'an', text: '收到。我让阿数拉漏斗，阿写准备结论页；先看 7 日窗口，移动端单独拆。', time: '09:13' },
      { type: 'handoff', id: 'ho-funnel', from: 'an', to: 'shu', task: 'funnel', time: '09:13' },
      { type: 'bot', bot: 'shu', text: '漏斗在「创建第一个 Goal」掉了 11 个点，其次是「邀请协作者」掉 4 个点。我把分群拆开了。', time: '09:26' },
      { type: 'artifact', id: 'art-funnel', task: 'funnel', bot: 'shu', time: '09:31', title: '激活漏斗归因', summary: '最大流失在「创建第一个 Goal」，移动端比桌面端高 6 个点。', evidence: ['漏斗数据', '分群切片', '会话回放'] },
      { type: 'failure', id: 'fail-write', task: 'write', bot: 'xie', time: '昨天 18:42', title: '写入目标表失败', text: '目标表拒绝了 2 条记录，已完成 8 条。原始回执已保留。', impact: '2 条记录未写入；不会自动重试。' },
      { type: 'digest', time: '09:40', stats: [['0', '完成'], ['2', '进行中'], ['1', '待领取'], ['1', '待验收'], ['1', '失败']] }
    ]
  },
  {
    id: 'feedback',
    name: '客户反馈',
    goal: '把本周 42 条反馈归因',
    status: '进行中',
    unread: false,
    members: ['an', 'gui', 'yan'],
    botStates: {
      an: { status: 'working', current: '协调反馈归因' },
      gui: { status: 'working', current: '聚类 42 条反馈 · 80%' },
      yan: { status: 'idle', current: '空闲 · 可接方案' }
    },
    tasks: [
      {
        id: 'cluster', title: '反馈主题聚类', status: 'working', owner: 'gui', progress: 80,
        budget: '3k', used: '2.2k', evidence: 3, deps: '—',
        note: '把 42 条反馈去重、归类，标出高频主题与原文。',
        deliverable: '主题聚类 + 高频原文',
        evidenceList: ['42 条反馈', '主题聚类', '会话样本'],
        steps: [
          { label: '导入 42 条', done: true },
          { label: '主题聚类', done: true },
          { label: '标高频主题', done: false, current: true }
        ]
      },
      {
        id: 'fix', title: '恢复入口最小方案', status: 'ready', owner: 'yan', progress: 0,
        budget: '6k', used: '0', evidence: 0, deps: '反馈归因',
        note: '针对“第一次运行失败后没有恢复入口”给出最小方案。',
        steps: [
          { label: '等待归因', done: false, current: true },
          { label: '画最小流程', done: false },
          { label: '评估工作量', done: false }
        ]
      },
      {
        id: 'reply', title: '回复本周反馈', status: 'review', owner: 'an', progress: 100,
        budget: '1k', used: '.6k', evidence: 2, deps: '归因',
        note: '给 5 位重点客户回复处理计划；不承诺未排期事项。',
        steps: [
          { label: '筛选重点客户', done: true },
          { label: '写回复草稿', done: true },
          { label: '待你验收', done: false, current: true }
        ]
      }
    ],
    files: [
      { name: '42 条反馈.csv', type: 'CSV', meta: '本周 · 11:01' },
      { name: '重点客户.md', type: 'MD', meta: '5 位 · 11:12' }
    ],
    messages: [
      { type: 'system', text: '小安把本周 42 条反馈加入频道', time: '11:02' },
      { type: 'human', text: '这周客户反馈里，最该先修的是什么？', time: '11:02' },
      { type: 'bot', bot: 'an', text: '收到。我让阿研做归因，阿归按主题聚类；先看「第一次运行失败」这一类。', time: '11:03' },
      { type: 'handoff', id: 'ho-cluster', from: 'an', to: 'gui', task: 'cluster', time: '11:03' },
      { type: 'bot', bot: 'gui', text: '42 条里 17 条指向同一个问题：第一次运行失败后没有恢复入口。剩下是权限和导出格式。', time: '11:14' },
      { type: 'artifact', id: 'art-feedback', task: 'cluster', bot: 'gui', time: '11:19', title: '客户反馈归因', summary: '17/42 指向「失败后无恢复入口」，集中在首次使用的第 2 天。', evidence: ['42 条反馈', '主题聚类', '会话样本'] },
      { type: 'digest', time: '11:20', stats: [['0', '完成'], ['1', '进行中'], ['1', '待领取'], ['1', '待验收']] }
    ]
  }
];

const APPROVALS = {
  ap1: { status: 'pending', mode: null, reason: '' }
};
const QUESTIONS = {
  q1: { status: 'pending', answer: null }
};
const RETRIED = {};
const ACCEPTED = {};

const state = {
  channel: 'launch',
  tab: 'team',
  studio: false,
  railOpen: false,
  sidebarOpen: false,
  drawer: null,
  rejecting: null,
  paletteOpen: false,
  paletteQuery: '',
  paletteIndex: 0,
  inboxFilter: 'all',
  thinking: null,
  pendingFocus: null,
  landed: false,
  settled: false,
  visited: { launch: true }
};

/* ── Icons ─────────────────────────────────────────────────── */

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  inbox: '<path d="M4 5h16v14H4z"/><path d="M4 13h4l2 3h4l2-3h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3 3 0 0 1 0 6M18 20a6 6 0 0 0-3-5"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  folder: '<path d="M3 7h6l2 2h10v10H3z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  send: '<path d="m4 12 16-7-7 16-2-7-7-2Z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/>',
  play: '<path d="m9 6 9 6-9 6V6Z"/>',
  chat: '<path d="M4 5h16v11H8l-4 4V5Z"/>',
  bot: '<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>'
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.dots}</svg>`;
}

function syncIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (!el.firstElementChild || el.dataset.synced !== el.dataset.icon) {
      el.innerHTML = icon(el.dataset.icon);
      el.dataset.synced = el.dataset.icon;
    }
  });
}

/* ── Helpers ───────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (value = '') => String(value).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const channelById = id => CHANNELS.find(c => c.id === id);
const currentChannel = () => channelById(state.channel) || CHANNELS[0];

function botState(id, ch = currentChannel()) {
  const override = ch.botStates && ch.botStates[id];
  const base = BOTS[id];
  return {
    status: override?.status || base.status,
    current: override?.current || base.current
  };
}

function findTask(id) {
  for (const ch of CHANNELS) {
    const task = ch.tasks.find(t => t.id === id);
    if (task) return { task, ch };
  }
  return null;
}

function avatarStyle(id) {
  const bot = BOTS[id];
  const tone = TONES[bot.tone] || TONES.blue;
  return `--av-bg:${tone.bg};--av-fg:${tone.fg}`;
}

function avatar(id, size = '') {
  const bot = BOTS[id];
  return `<span class="avatar ${size}" style="${avatarStyle(id)}" aria-hidden="true">${bot.initial}</span>`;
}

function avatarButton(id, size = '', label = '') {
  return `<button class="avatar ${size}" style="${avatarStyle(id)}" data-action="open-bot" data-bot="${id}" aria-label="${label || `查看 ${BOTS[id].name}`}">${BOTS[id].initial}</button>`;
}

function statusDot(status) {
  return `<span class="status-dot ${status}" aria-hidden="true"></span>`;
}

function statusPill(status) {
  return `<span class="status-pill ${status}">${STATUS_LABEL[status] || status}</span>`;
}

function botStatusPill(status) {
  return `<span class="status-pill ${status}">${BOT_STATUS_LABEL[status] || status}</span>`;
}

function announce(text) {
  const region = $('#liveRegion');
  if (region) region.textContent = text;
}

function activeInbox() {
  const items = [];
  if (APPROVALS.ap1.status === 'pending') {
    items.push({
      id: 'ap1', kind: '待批准', kindClass: '', channel: 'launch',
      title: '阿研请求读取 3 个外部页面',
      meta: '只读 · 约 2 分钟 · 预算 2k', age: '2 分钟', focus: 'event-ap1'
    });
  }
  if (QUESTIONS.q1.status === 'pending') {
    items.push({
      id: 'q1', kind: '待确认', kindClass: '', channel: 'launch',
      title: '发布窗口按周一还是周三评估？',
      meta: '阿研 · 确认发布窗口', age: '8 分钟', focus: 'event-q1'
    });
  }
  if (!RETRIED['fail-write']) {
    items.push({
      id: 'fail-write', kind: '失败', kindClass: 'failed', channel: 'growth',
      title: '写入失败：目标表拒绝 2 条记录',
      meta: '阿写 · 增长实验', age: '昨天', focus: 'event-fail-write'
    });
  }
  return items;
}

function needsFor(ch) {
  return activeInbox().filter(item => item.channel === ch.id).length;
}

/* ── Sidebar ───────────────────────────────────────────────── */

function renderSidebar() {
  const inboxCount = activeInbox().length;
  const nav = `
    <div class="sidebar-section" style="margin-top:4px">
      <button class="nav-item" type="button" data-action="open-inbox">
        ${icon('inbox')}<span>收件箱</span><span class="spacer"></span>
        ${inboxCount ? `<span class="badge badge-amber">${inboxCount}</span>` : ''}
      </button>
    </div>
    <div class="sidebar-section">
      <div class="section-head"><span>频道</span></div>
      ${CHANNELS.map(ch => {
        const needs = needsFor(ch);
        const active = ch.id === state.channel;
        const meta = needs
          ? `<span class="badge badge-amber">${needs}</span>`
          : (!state.visited[ch.id] && ch.unread ? '<span class="unread-dot"></span>' : '');
        return `<button class="channel-item ${active ? 'active' : ''}" type="button" data-action="switch-channel" data-channel="${ch.id}" ${active ? 'aria-current="page"' : ''}>
          <span class="channel-hash">#</span>
          <span class="channel-name">${esc(ch.name)}</span>
          <span class="channel-meta">${meta}</span>
        </button>`;
      }).join('')}
    </div>
    <div class="sidebar-section">
      <div class="section-head"><span>直接消息</span></div>
      <button class="channel-item" type="button" data-action="direct-an">
        ${avatar('an', 'avatar-xs')}
        <span class="channel-name">小安</span>
        <span class="channel-meta"><span class="roster-role">PM</span></span>
      </button>
    </div>
  `;
  $('#sidebarNav').innerHTML = nav;
  $('#sidebarFooter').innerHTML = `
    <div class="sidebar-bottom">
      <button class="nav-item" type="button" data-action="bot-directory">${icon('users')}<span>Bot 团队</span></button>
      <button class="nav-item" type="button" data-action="toggle-studio">${icon('grid')}<span>工作室</span></button>
      <button class="nav-item" type="button" data-action="settings">${icon('spark')}<span>设置</span></button>
    </div>
  `;
}

/* ── Header ────────────────────────────────────────────────── */

function renderHeader() {
  const ch = currentChannel();
  const needs = needsFor(ch);
  const working = ch.members.filter(id => botState(id, ch).status === 'working').length;
  const members = ch.members.slice(0, 4).map(id => avatar(id, 'avatar-xs')).join('');
  const extra = ch.members.length > 4 ? `<span class="member-more">+${ch.members.length - 4}</span>` : '';

  $('#channelHead').innerHTML = `
    <div class="head-left">
      <button class="icon-btn mobile-only" type="button" data-action="toggle-sidebar" aria-label="打开频道列表">${icon('menu')}</button>
      <span class="channel-box" aria-hidden="true">#</span>
      <div class="channel-title">
        <div class="channel-name-row">
          <h1>${esc(ch.name)}</h1>
          <span class="head-status"><i></i>${esc(ch.status)}</span>
        </div>
        <p class="channel-goal">目标：${esc(ch.goal)}</p>
      </div>
    </div>
    <div class="head-right">
      <div class="member-stack" aria-label="${ch.members.length} 位 Bot 成员">${members}${extra}</div>
      <span class="floor-meta" style="margin:0 4px 0 0" title="${working} 个 Bot 正在工作">
        <span class="live"><i></i>${working} 工作中</span>
      </span>
      <button class="head-btn rail-toggle" type="button" data-action="toggle-rail">${icon('users')}<span class="head-btn-label">团队</span></button>
      <button class="head-btn workspace-btn" type="button" data-action="open-board">${icon('board')}<span class="head-btn-label">任务板</span></button>
      <button class="head-btn studio-btn ${state.studio ? 'active' : ''}" type="button" data-action="toggle-studio">${icon('grid')}<span class="head-btn-label">工作室</span></button>
      <button class="icon-btn" type="button" data-action="open-inbox" aria-label="收件箱，${needs} 项需要你">
        ${icon('inbox')}${needs ? `<span class="icon-badge">${needs}</span>` : ''}
      </button>
    </div>
  `;
}

/* ── Stream ────────────────────────────────────────────────── */

function renderStream() {
  const ch = currentChannel();
  const thinking = state.thinking && state.thinking.channel === ch.id
    ? `<article class="msg bot">${avatar('an', 'msg-avatar')}<div class="msg-content"><div class="msg-head"><span class="msg-who">小安</span><span class="msg-role">PM</span><span class="bot-tag">Bot</span><span class="msg-time">正在处理</span></div><div class="thinking-dots" aria-label="小安正在处理"><i></i><i></i><i></i></div></div></article>`
    : '';
  $('#stream').innerHTML = `<div class="stream-inner">${ch.messages.map(renderMessage).join('')}${thinking}</div>`;
  if (!state.pendingFocus) {
    if (!state.landed) {
      state.landed = true;
      requestAnimationFrame(() => { $('#stream').scrollTop = 0; });
    } else {
      scrollToBottom();
    }
  }
}

function renderMessage(m, index) {
  const fallbackId = m.id ? `event-${m.id}` : '';
  switch (m.type) {
    case 'system':
      return `<div class="system-line" ${fallbackId ? `id="${fallbackId}"` : ''}><span>${esc(m.text)}</span><time>${esc(m.time)}</time></div>`;

    case 'human':
      return `<article class="msg human" ${fallbackId ? `id="${fallbackId}"` : ''}>
        <div class="msg-content">
          <div class="msg-head"><span class="msg-who">你</span><span class="msg-time">${esc(m.time)}</span></div>
          <div class="msg-text">${esc(m.text)}</div>
        </div>
        <span class="avatar avatar-human msg-avatar" aria-hidden="true">K</span>
      </article>`;

    case 'bot': {
      const bot = BOTS[m.bot];
      return `<article class="msg bot" ${fallbackId ? `id="${fallbackId}"` : ''}>
        ${avatarButton(m.bot, 'msg-avatar')}
        <div class="msg-content">
          <div class="msg-head">
            <button class="msg-who" type="button" data-action="open-bot" data-bot="${m.bot}">${esc(bot.name)}</button>
            <span class="msg-role">${esc(bot.role)}</span>
            <span class="bot-tag">Bot</span>
            <span class="msg-time">${esc(m.time)}</span>
          </div>
          <div class="msg-text">${esc(m.text)}</div>
        </div>
      </article>`;
    }

    case 'handoff':
      return renderHandoff(m);
    case 'approval':
      return renderApproval(m);
    case 'question':
      return renderQuestion(m);
    case 'artifact':
      return renderArtifact(m);
    case 'failure':
      return renderFailure(m);
    case 'digest':
      return renderDigest(m);
    case 'task':
      return renderTaskMessage(m);

    default:
      return '';
  }
}

function renderHandoff(m) {
  const task = findTask(m.task)?.task;
  if (!task) return '';
  const from = BOTS[m.from];
  const to = BOTS[m.to];
  return `<div class="event" id="${m.id ? `event-${m.id}` : ''}">
    <div class="card handoff">
      <div class="card-head">
        <span class="card-kicker kicker-blue">交接</span>
        <span class="card-time">${esc(m.time)}</span>
      </div>
      <div class="handoff-route">
        <span class="route-node">${avatar(m.from, 'avatar-xs')}<span>${esc(from.name)}</span></span>
        <span class="route-arrow">${icon('arrow')}</span>
        <span class="route-node">${avatar(m.to, 'avatar-xs')}<span>${esc(to.name)}</span></span>
        <span class="route-status">已接手 · 预计 6–10 分钟</span>
      </div>
      <div class="card-body">
        <dl class="kv">
          <dt>任务</dt><dd><strong>${esc(task.title)}</strong>：${esc(task.note)}</dd>
          <dt>交付</dt><dd>${esc(task.deliverable || '结论 + 证据链')}</dd>
          <dt>上下文</dt><dd>频道资料 + 上游结论 · 预算 ${esc(task.budget)}</dd>
        </dl>
        <div class="card-foot">
          <button class="btn btn-soft" type="button" data-action="open-task" data-task="${task.id}">打开任务</button>
          <span class="card-foot-note">交接链可在任务详情里回放</span>
        </div>
      </div>
    </div>
  </div>`;
}

function renderApproval(m) {
  const task = findTask(m.task)?.task;
  const approval = APPROVALS[m.id] || { status: 'pending' };
  const resolved = approval.status !== 'pending';
  const modeLabel = approval.mode === 'once' ? '仅这一次' : '本任务内有效';

  if (resolved) {
    const rejected = approval.status === 'rejected';
    return `<div class="event" id="event-${m.id}">
      <div class="card approval">
        <div class="card-head">
          <span class="card-kicker ${rejected ? 'kicker-red' : 'kicker-cyan'}">${rejected ? '已拒绝' : `已批准 · ${modeLabel}`}</span>
          <span class="card-time">${esc(m.time)}</span>
        </div>
        <div class="card-body">
          <div class="approval-title">读取 3 个外部页面</div>
          <div class="approval-resolved ${rejected ? 'rejected' : ''}">
            <span class="state-icon">${icon(rejected ? 'x' : 'check')}</span>
            <span>${rejected
              ? `你拒绝了这次读取。${approval.reason ? `原因：${esc(approval.reason)}` : ''} 阿研会改用频道内资料，结论将标“未验证”。`
              : `阿研已继续执行。本次只读公开页面，不写入、不发送。`}</span>
          </div>
        </div>
      </div>
    </div>`;
  }

  const rejectForm = state.rejecting === m.id ? `
    <div class="reject-form">
      <textarea id="rejectReason" placeholder="写一句原因，阿研会据此调整方案（必填）"></textarea>
      <div class="reject-form-actions">
        <button class="btn btn-quiet" type="button" data-action="cancel-reject">取消</button>
        <button class="btn btn-danger" type="button" data-action="confirm-reject" data-approval="${m.id}">确认拒绝</button>
      </div>
    </div>` : '';

  return `<div class="event" id="event-${m.id}">
    <div class="card approval">
      <div class="card-head">
        <span class="card-kicker kicker-amber">需要你批准</span>
        <span class="card-time">${esc(m.time)}</span>
      </div>
      <div class="card-body">
        <div class="approval-title">读取 3 个外部页面</div>
        <dl class="kv">
          <dt>目的</dt><dd>核对供应商的发布窗口</dd>
          <dt>接触</dt><dd>3 个公开页面 · 只读 · 不登录</dd>
          <dt>花费</dt><dd>约 2 分钟 · 预算 2k</dd>
          <dt>风险</dt><dd>低 · 不写入、不发送</dd>
        </dl>
        <div class="approval-actions">
          <button class="btn btn-primary" type="button" data-action="approve" data-approval="${m.id}" data-decision="always">批准</button>
          <button class="btn" type="button" data-action="approve" data-approval="${m.id}" data-decision="once">仅这一次</button>
          <button class="btn btn-danger" type="button" data-action="reject" data-approval="${m.id}">拒绝并说明</button>
        </div>
        ${rejectForm}
      </div>
    </div>
  </div>`;
}

function renderQuestion(m) {
  const q = QUESTIONS[m.id] || { status: 'pending' };
  if (q.status === 'answered') {
    return `<div class="event" id="event-${m.id}">
      <div class="card question">
        <div class="card-head">
          <span class="card-kicker kicker-cyan">已确认</span>
          <span class="card-time">${esc(m.time)}</span>
        </div>
        <div class="card-body">
          <p class="question-text">发布窗口按 <strong>${esc(q.answer)}</strong> 评估。阿研会以这个日期重排风险。</p>
        </div>
      </div>
    </div>`;
  }
  const options = ['周一', '周三', '先不定'].map(option =>
    `<button class="option-btn" type="button" data-action="answer" data-question="${m.id}" data-answer="${option}">${option}</button>`
  ).join('');
  return `<div class="event" id="event-${m.id}">
    <div class="card question">
      <div class="card-head">
        <span class="card-kicker kicker-red">卡住了 · 需要你确认</span>
        <span class="card-time">${esc(m.time)}</span>
      </div>
      <div class="card-body">
        <p class="question-text">发布窗口在资料里有两个版本：周一 / 周三。你希望按哪个日期评估风险？</p>
        <div class="quick-options">${options}</div>
      </div>
    </div>
  </div>`;
}

function renderArtifact(m) {
  const task = findTask(m.task)?.task;
  const accepted = !!ACCEPTED[m.id];
  return `<div class="event" id="event-${m.id}">
    <div class="card artifact">
      <div class="card-head">
        <span class="card-kicker kicker-cyan">产物</span>
        <span class="card-time">${esc(m.time)}</span>
      </div>
      <div class="card-body">
        <h3 class="artifact-title">${esc(m.title)}</h3>
        <p class="artifact-summary">${esc(m.summary)}</p>
        <div class="evidence-row">
          <span class="evidence-label">证据</span>
          ${m.evidence.map((item, i) => `<button class="chip" type="button" data-action="open-task" data-task="${m.task}">[S${i + 1}] ${esc(item)}</button>`).join('')}
        </div>
        <div class="card-foot">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn" type="button" data-action="open-task" data-task="${m.task}">阅读全文</button>
            <button class="btn btn-soft" type="button" data-action="accept-artifact" data-artifact="${m.id}" ${accepted ? 'disabled' : ''}>${accepted ? '已验收' : '验收'}</button>
          </div>
          <span class="card-foot-note">${accepted ? '已进入下游' : '验收后下游自动解锁'}</span>
        </div>
      </div>
    </div>
  </div>`;
}

function renderFailure(m) {
  const retried = !!RETRIED[m.id];
  return `<div class="event" id="event-${m.id}">
    <div class="card failure">
      <div class="card-head">
        <span class="card-kicker ${retried ? 'kicker-cyan' : 'kicker-red'}">${retried ? '已恢复' : '失败 · 写入目标表'}</span>
        <span class="card-time">${esc(m.time)}</span>
      </div>
      <div class="card-body">
        ${retried
          ? `<p>重试成功：2 条记录已写入，目标表已对齐。原始回执保留。</p>`
          : `<p>目标表拒绝了 2 条记录，已完成 8 条。原始回执已保留。</p>
             <dl class="kv" style="margin-top:8px"><dt>影响</dt><dd>${esc(m.impact)}</dd><dt>建议</dt><dd>先看回执，再决定重试或导出。</dd></dl>
             <div class="card-foot">
               <div style="display:flex;gap:6px;flex-wrap:wrap">
                 <button class="btn" type="button" data-action="open-task" data-task="${m.task}">查看原因</button>
                 <button class="btn btn-danger" type="button" data-action="retry-failure" data-failure="${m.id}">重试 2 条</button>
               </div>
               <span class="card-foot-note">有外部副作用，不自动重试</span>
             </div>`}
      </div>
    </div>
  </div>`;
}

function renderDigest(m) {
  return `<div class="digest" id="${m.id ? `event-${m.id}` : ''}">
    <span class="digest-kicker">团队摘要 · ${esc(m.time)}</span>
    <span class="digest-stats">
      ${m.stats.map(([num, label]) => `<span class="digest-stat"><b>${num}</b>${label}</span>`).join('')}
    </span>
  </div>`;
}

function renderTaskMessage(m) {
  const found = findTask(m.task);
  if (!found) return '';
  const { task, ch } = found;
  return `<div class="event">
    <button class="task-mini" type="button" data-action="open-task" data-task="${task.id}" style="width:100%;text-align:left">
      ${avatar(task.owner, 'avatar-sm')}
      <span class="task-mini-copy">
        <span class="task-mini-title">${esc(task.title)}</span>
        <span class="task-mini-meta">${esc(ch.name)} · ${STATUS_LABEL[task.status]} · ${task.progress}%</span>
      </span>
      <span class="icon-slot" style="color:#8b97a9">${icon('chevron')}</span>
    </button>
  </div>`;
}

/* ── Rail ──────────────────────────────────────────────────── */

function renderRail() {
  const ch = currentChannel();
  const inbox = activeInbox();
  const needs = needsFor(ch);
  const tab = state.tab;

  const needsStrip = needs ? `
    <div class="needs-strip">
      <span class="needs-icon">!</span>
      <span><strong>${needs} 个决定</strong>等待你</span>
      <button type="button" data-action="open-inbox">查看</button>
    </div>` : '';

  let body = '';
  if (tab === 'team') {
    body = `
      <div class="rail-summary">
        <span>${ch.members.length} 个 Bot</span>
        <span class="live"><i></i>${ch.members.filter(id => botState(id, ch).status === 'working').length} 工作中</span>
      </div>
      <div class="roster">
        ${ch.members
          .slice()
          .sort((a, b) => botSort(a, ch) - botSort(b, ch))
          .map(id => {
            const bot = BOTS[id];
            const live = botState(id, ch);
            return `<button class="roster-item" type="button" data-action="open-bot" data-bot="${id}">
              ${avatar(id, 'avatar-sm')}
              <span class="roster-copy">
                <span class="roster-name-row"><span class="roster-name">${esc(bot.name)}</span><span class="roster-role">${esc(bot.role)}</span></span>
                <span class="roster-task">${statusDot(live.status)} ${esc(live.current)}</span>
              </span>
            </button>`;
          }).join('')}
      </div>
      <div class="rail-foot"><button class="rail-link" type="button" data-action="bot-directory">查看 Bot 团队 ${icon('chevron')}</button></div>
      <div class="evidence-box" style="margin-top:12px"><b>这个频道的约定</b><br>默认一个声音；@ 才点名；只有审批、阻塞、失败才打断你。</div>
    `;
  } else if (tab === 'tasks') {
    const counts = ['working', 'blocked', 'review'].map(status => ({
      status, count: ch.tasks.filter(t => t.status === status).length
    }));
    body = `
      <div class="task-summary">
        ${counts.map(item => `<div><b>${item.count}</b><span>${STATUS_LABEL[item.status]}</span></div>`).join('')}
      </div>
      <button class="btn btn-soft" type="button" data-action="open-board" style="width:100%;margin-bottom:4px">${icon('board')} 打开任务看板</button>
      ${['working', 'blocked', 'review'].map(status => {
        const tasks = ch.tasks.filter(t => t.status === status);
        if (!tasks.length) return '';
        return `<div class="task-group">
          <div class="task-group-head"><span>${STATUS_LABEL[status]}</span><span>${tasks.length}</span></div>
          ${tasks.map(task => `
            <button class="task-row" type="button" data-action="open-task" data-task="${task.id}">
              <span class="task-row-top"><strong>${esc(task.title)}</strong>${statusPill(task.status)}</span>
              <small>${esc(BOTS[task.owner].name)} · ${task.progress}% · 证据 ${task.evidence}</small>
            </button>`).join('')}
        </div>`;
      }).join('')}
    `;
  } else {
    body = `
      <div class="rail-summary"><span>${ch.files.length} 个来源</span><span>证据 4 · 回执 2</span></div>
      <div class="file-list">
        ${ch.files.map(file => `
          <div class="file-row">
            <span class="file-type ${file.type.toLowerCase()}">${esc(file.type)}</span>
            <span class="file-copy"><strong>${esc(file.name)}</strong><small>${esc(file.meta)}</small></span>
          </div>`).join('')}
      </div>
      <div class="evidence-box"><b>证据链</b><br>4 个来源已关联到「评估发布风险」；2 个外部回执待核对。</div>
      <div class="rail-foot"><button class="rail-link" type="button" data-action="open-task" data-task="risk">打开任务证据 ${icon('chevron')}</button></div>
    `;
  }

  $('#rail').innerHTML = `
    <div class="rail-head">
      <div class="rail-title-row">
        <h2 class="rail-title">频道上下文</h2>
        <span style="display:flex;align-items:center;gap:4px">
          <span class="rail-count">${activeInbox().length} 待办</span>
          <button class="icon-btn rail-close" type="button" data-action="toggle-rail" aria-label="关闭团队面板">${icon('x')}</button>
        </span>
      </div>
      ${needsStrip}
      <div class="tabs" role="tablist" aria-label="频道上下文">
        <button class="tab ${tab === 'team' ? 'active' : ''}" type="button" role="tab" aria-selected="${tab === 'team'}" data-action="tab" data-tab="team">团队 <span class="tab-count">${ch.members.length}</span></button>
        <button class="tab ${tab === 'tasks' ? 'active' : ''}" type="button" role="tab" aria-selected="${tab === 'tasks'}" data-action="tab" data-tab="tasks">任务 <span class="tab-count">${ch.tasks.length}</span></button>
        <button class="tab ${tab === 'files' ? 'active' : ''}" type="button" role="tab" aria-selected="${tab === 'files'}" data-action="tab" data-tab="files">资料 <span class="tab-count">${ch.files.length}</span></button>
      </div>
    </div>
    <div class="rail-body">${body}</div>
  `;
}

function botSort(id, ch = currentChannel()) {
  const order = { blocked: 0, working: 1, waiting: 2, idle: 3, paused: 4, offline: 5 };
  return order[botState(id, ch).status] ?? 9;
}

/* ── Studio ────────────────────────────────────────────────── */

function renderStudio() {
  if (!state.studio) return;
  const ch = currentChannel();
  const handoff = ch.messages.find(m => m.type === 'handoff');
  const handoffTask = handoff ? findTask(handoff.task)?.task : null;
  const specialists = ch.members.filter(id => id !== 'an');
  const positions = ['desk-a', 'desk-b', 'desk-c'];
  const inbox = activeInbox().filter(item => item.channel === ch.id);
  const working = ch.members.filter(id => botState(id, ch).status === 'working').length;

  const desk = (id, extra = '') => {
    const bot = BOTS[id];
    const live = botState(id, ch);
    return `<button class="desk ${extra} ${live.status === 'offline' ? 'desk-offline' : ''}" type="button" data-action="open-bot" data-bot="${id}">
      ${avatar(id, 'avatar-sm')}
      <span class="desk-copy">
        <span class="desk-name">${esc(bot.name)}<span class="desk-role">${esc(bot.role)}</span></span>
        <span class="desk-status">${statusDot(live.status)} ${esc(live.current)}</span>
      </span>
    </button>`;
  };

  const liveItems = ch.messages
    .filter(m => m.type === 'handoff' || m.type === 'bot' || (m.type === 'approval' && APPROVALS[m.id]?.status === 'pending'))
    .slice(-4)
    .reverse()
    .map(m => {
      if (m.type === 'handoff') {
        const task = findTask(m.task)?.task;
        return `<div class="studio-item">${avatar(m.from, 'avatar-xs')}<div><strong>${esc(BOTS[m.from].name)} → ${esc(BOTS[m.to].name)}</strong><span>交接 ${esc(task?.title || '')} · ${esc(m.time)}</span></div></div>`;
      }
      if (m.type === 'approval') {
        return `<div class="studio-item">${avatar(m.bot, 'avatar-xs')}<div><strong>${esc(BOTS[m.bot].name)} 请求批准</strong><span>读取 3 个外部页面 · ${esc(m.time)}</span></div></div>`;
      }
      return `<div class="studio-item">${avatar(m.bot, 'avatar-xs')}<div><strong>${esc(BOTS[m.bot].name)}</strong><span>${esc(m.text.slice(0, 34))}${m.text.length > 34 ? '…' : ''}</span></div></div>`;
    }).join('');

  const needsItems = inbox.length
    ? inbox.map(item => `<div class="studio-need"><span class="mark"></span><div><strong>${esc(item.title)}</strong><span>${esc(item.kind)} · ${esc(item.age)}</span></div></div>`).join('')
    : `<div class="studio-empty">没有需要你决定的事。团队会继续工作。</div>`;

  $('#studio').innerHTML = `
    <div class="studio-floor">
      <div class="floor-head">
        <div>
          <div class="floor-kicker">工作室 · 只读视图</div>
          <h2 class="floor-title">${esc(ch.name)}</h2>
        </div>
        <div class="floor-meta">
          <span class="live"><i></i>${working} 人在忙</span>
          <button class="head-btn" type="button" data-action="toggle-studio">${icon('chat')} 回到频道</button>
        </div>
      </div>
      <div class="floor-canvas ${state.replaying ? 'replaying' : ''}">
        <div class="room room-meeting"><span class="room-label">会议室</span></div>
        <div class="room room-work"><span class="room-label">工位区</span></div>
        ${desk('an', 'desk-pm')}
        ${specialists.slice(0, 3).map((id, i) => desk(id, positions[i])).join('')}
        ${handoff ? `
          <svg class="floor-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path class="handoff-path" d="M22,34 C34,20 48,38 60,28"></path>
            <circle class="handoff-dot" r="1.1">
              <animateMotion dur="3.6s" repeatCount="indefinite" path="M22,34 C34,20 48,38 60,28"></animateMotion>
            </circle>
          </svg>
          <span class="handoff-label">交接 · ${esc(BOTS[handoff.from].name)} → ${esc(BOTS[handoff.to].name)} · ${esc(handoff.time)}</span>
        ` : ''}
      </div>
    </div>
    <aside class="studio-side">
      <div class="studio-block">
        <h3>正在发生</h3>
        ${liveItems || '<div class="studio-empty">频道刚刚安静下来。</div>'}
      </div>
      <div class="studio-block">
        <h3>需要你 · ${inbox.length}</h3>
        ${needsItems}
        ${inbox.length ? `<div class="studio-replay"><span>打开收件箱处理</span><button class="rail-link" type="button" data-action="open-inbox">查看 ${icon('chevron')}</button></div>` : ''}
      </div>
      <div class="studio-block">
        <h3>回放</h3>
        <div class="studio-empty">${handoffTask ? `一次交接：${esc(handoffTask.title)}` : '暂无交接'}</div>
        <div class="studio-replay">
          <span>${state.replaying ? '正在回放…' : '小安 → 阿研 · 10:03'}</span>
          <button class="rail-link" type="button" data-action="replay">${icon('play')} 回放</button>
        </div>
      </div>
    </aside>
  `;
}

/* ── Drawers ───────────────────────────────────────────────── */

function openDrawer(type, id) {
  closeSidebar();
  closeRail();
  if (!state.drawer) state.lastFocus = document.activeElement;
  state.drawer = { type, id };
  const drawer = $('#drawer');
  drawer.innerHTML = renderDrawer(type, id);
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  const scrim = $('#scrim');
  scrim.hidden = false;
  requestAnimationFrame(() => $('.drawer-close', drawer)?.focus());
}

function closeDrawer() {
  state.drawer = null;
  state.rejecting = null;
  const drawer = $('#drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  const previous = state.lastFocus;
  setTimeout(() => {
    if (!state.drawer) drawer.innerHTML = '';
  }, 320);
  if (previous && document.contains(previous)) previous.focus();
}

function renderDrawer(type, id) {
  if (type === 'task') return renderTaskDrawer(id);
  if (type === 'bot') return renderBotDrawer(id);
  if (type === 'inbox') return renderInboxDrawer();
  if (type === 'directory') return renderDirectoryDrawer();
  if (type === 'failed') return renderFailedDrawer();
  if (type === 'settings') return renderSettingsDrawer();
  return '';
}

function renderTaskDrawer(id) {
  const found = findTask(id);
  if (!found) return '';
  const { task, ch } = found;
  const owner = BOTS[task.owner];
  const handoff = ch.messages.find(m => m.type === 'handoff' && m.task === task.id);
  const trailFrom = handoff ? BOTS[handoff.from].name : '小安';
  const trailTo = BOTS[task.owner].name;
  const trailTime = handoff?.time || '创建时';
  const evidenceNames = task.evidenceList || ch.files.map(file => file.name);
  return `
    <div class="drawer-head">
      <div class="drawer-head-copy">
        <div class="drawer-kicker">任务 · ${esc(ch.name)}</div>
        <h2 class="drawer-title">${esc(task.title)}</h2>
        <p class="drawer-sub">${esc(task.id.toUpperCase())} · ${esc(owner.name)} · ${esc(ch.goal)}</p>
      </div>
      <button class="icon-btn drawer-close" type="button" data-action="close-drawer" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        ${statusPill(task.status)}
        <span class="mono" style="color:#7d8ba1;font:400 10px var(--mono)">进度 ${task.progress}%</span>
      </div>
      <p class="drawer-lede">${esc(task.note)}</p>
      <div class="progress-track" aria-label="任务进度"><i style="width:${task.progress}%"></i></div>

      <div class="section-label">任务信息</div>
      <dl class="detail-grid">
        <dt>Owner</dt><dd>${esc(owner.name)} · ${esc(owner.role)}</dd>
        <dt>预算</dt><dd>${esc(task.budget)} · 已用 ${esc(task.used)}</dd>
        <dt>依赖</dt><dd>${esc(task.deps)}</dd>
        <dt>证据</dt><dd>${evidenceNames.length} 个来源</dd>
        <dt>频道</dt><dd>${esc(ch.name)}</dd>
      </dl>

      <div class="section-label">执行步骤</div>
      <ol class="steps">
        ${task.steps.map(step => `<li class="step ${step.done ? 'done' : ''} ${step.current ? 'current' : ''}">${esc(step.label)}</li>`).join('')}
      </ol>

      <div class="section-label">证据</div>
      <div class="evidence-row">
        ${evidenceNames.map((name, i) => `<span class="chip">[S${i + 1}] ${esc(name)}</span>`).join('')}
      </div>

      <div class="section-label">交接链</div>
      <div class="handoff-trail">
        ${trailFrom === trailTo
          ? `<div class="trail-item">${avatar(task.owner, 'avatar-xs')}<div class="trail-copy"><strong>${esc(trailTo)} · 创建任务</strong><span>${esc(trailTime)} · ${esc(STATUS_LABEL[task.status])}</span></div></div>`
          : `<div class="trail-item">${avatar(handoff ? handoff.from : 'an', 'avatar-xs')}<div class="trail-copy"><strong>${esc(trailFrom)} → ${esc(trailTo)}</strong><span>${esc(trailTime)} · 交接「${esc(task.title)}」</span></div></div>
             <div class="trail-item">${avatar(task.owner, 'avatar-xs')}<div class="trail-copy"><strong>${esc(trailTo)} · ${task.status === 'done' ? '已完成' : '执行中'}</strong><span>${esc(STATUS_LABEL[task.status])} · ${task.progress}%</span></div></div>`}
      </div>
    </div>
    <div class="drawer-foot">
      <button class="btn" type="button" data-action="close-drawer">关闭</button>
      <button class="btn btn-primary" type="button" data-action="mention-bot" data-bot="${task.owner}">在频道中问 ${esc(owner.name)}</button>
    </div>`;
}

function renderBotDrawer(id) {
  const bot = BOTS[id];
  if (!bot) return '';
  const live = botState(id);
  return `
    <div class="drawer-head">
      <div class="drawer-head-copy">
        <div class="drawer-kicker">Bot 档案</div>
        <h2 class="drawer-title">${esc(bot.name)}</h2>
        <p class="drawer-sub">${esc(bot.role)} · ${esc(BOT_STATUS_LABEL[live.status])}</p>
      </div>
      <button class="icon-btn drawer-close" type="button" data-action="close-drawer" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      <div class="bot-profile-head">
        <span class="avatar avatar-lg" style="${avatarStyle(id)}">${bot.initial}</span>
        <div>
          <div style="display:flex;align-items:center;gap:6px">${statusDot(live.status)}<span style="font-size:11px;color:#6d7b90">${esc(live.current)}</span></div>
          <div style="margin-top:5px;font:400 10px var(--mono);color:#7d8ba1">当前频道 · ${esc(currentChannel().name)}</div>
        </div>
      </div>
      <p class="drawer-lede">${esc(bot.desc)}</p>
      <div class="section-label">记忆</div>
      <div class="evidence-row">${bot.memory.map(item => `<span class="chip">${esc(item)}</span>`).join('')}</div>
      <div class="section-label">权限</div>
      <ul class="permission-list">
        ${bot.perms.map(([name, value]) => `<li>${esc(name)}<span>${esc(value)}</span></li>`).join('')}
      </ul>
      <div class="section-label">最近</div>
      <p style="margin:0;color:#3f4c62;font-size:11px;line-height:1.6">${esc(bot.recent)}</p>
    </div>
    <div class="drawer-foot">
      <button class="btn" type="button" data-action="close-drawer">关闭</button>
      <button class="btn btn-primary" type="button" data-action="mention-bot" data-bot="${id}">在频道中提及</button>
    </div>`;
}

function renderInboxDrawer() {
  const items = activeInbox();
  const filter = state.inboxFilter;
  const filtered = filter === 'all' ? items : items.filter(item => item.kind === filter);
  const filters = [
    ['all', '全部'], ['待批准', '待批准'], ['待确认', '待确认'], ['失败', '失败']
  ];
  return `
    <div class="drawer-head">
      <div class="drawer-head-copy">
        <div class="drawer-kicker">跨频道 · 只收需要你决定的事</div>
        <h2 class="drawer-title">收件箱</h2>
        <p class="drawer-sub">${items.length} 项待处理 · 按严重级与等待时间排序</p>
      </div>
      <button class="icon-btn drawer-close" type="button" data-action="close-drawer" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      <div class="quick-options" style="margin:0 0 10px">
        ${filters.map(([value, label]) => `<button class="option-btn" type="button" data-action="inbox-filter" data-filter="${value}" style="${filter === value ? 'border-color:#315efb;background:#eef4ff;color:#2347d5' : ''}">${label}</button>`).join('')}
      </div>
      ${filtered.length ? filtered.map(item => `
        <button class="inbox-item" type="button" data-action="goto" data-item="${item.id}">
          <span class="inbox-kind ${item.kindClass}">${esc(item.kind)}</span>
          <span class="inbox-copy"><strong>${esc(item.title)}</strong><small>${esc(item.meta)}</small></span>
          <span class="inbox-age">${esc(item.age)}</span>
        </button>`).join('') : `<div class="empty-state"><b>没有需要你决定的事</b>团队会继续工作；这里只在审批、提问/阻塞、结果不明、失败或直接 @ 时出现。</div>`}
    </div>`;
}

function renderDirectoryDrawer() {
  return `
    <div class="drawer-head">
      <div class="drawer-head-copy">
        <div class="drawer-kicker">工作区 · Bot 团队</div>
        <h2 class="drawer-title">Bot 团队</h2>
        <p class="drawer-sub">${Object.keys(BOTS).length} 个 Bot · 跨频道复用</p>
      </div>
      <button class="icon-btn drawer-close" type="button" data-action="close-drawer" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      ${Object.entries(BOTS).map(([id, bot]) => `
        <button class="inbox-item" type="button" data-action="open-bot" data-bot="${id}">
          ${avatar(id, 'avatar-sm')}
          <span class="inbox-copy"><strong>${esc(bot.name)} · ${esc(bot.role)}</strong><small>${esc(botState(id).current)}</small></span>
          <span class="inbox-age">${esc(BOT_STATUS_LABEL[botState(id).status])}</span>
        </button>`).join('')}
      <div class="empty-state" style="text-align:left;padding:14px 2px 0"><b>组队规则</b>优先复用已有 Bot；每个频道最多 5 个专家 + 1 个 PM；新建 Bot 需要批准。</div>
    </div>`;
}

function renderFailedDrawer() {
  const ch = currentChannel();
  const failed = ch.tasks.filter(task => task.status === 'failed');
  return `
    <div class="drawer-head">
      <div class="drawer-head-copy">
        <div class="drawer-kicker">任务看板 · 失败筛选</div>
        <h2 class="drawer-title">失败任务</h2>
        <p class="drawer-sub">${esc(ch.name)} · ${failed.length} 个需要处理</p>
      </div>
      <button class="icon-btn drawer-close" type="button" data-action="close-drawer" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      ${failed.length ? failed.map(task => `
        <button class="inbox-item" type="button" data-action="open-task" data-task="${task.id}">
          <span class="inbox-kind failed">失败</span>
          <span class="inbox-copy"><strong>${esc(task.title)}</strong><small>${esc(BOTS[task.owner].name)} · ${task.progress}% · 不自动重试</small></span>
          <span class="inbox-age">查看</span>
        </button>`).join('') : `<div class="empty-state"><b>没有失败任务</b>重试或改派后，这里会自动清空。</div>`}
    </div>
    <div class="drawer-foot"><button class="btn" type="button" data-action="close-drawer">关闭</button></div>`;
}

function renderSettingsDrawer() {
  return `
    <div class="drawer-head">
      <div class="drawer-head-copy">
        <div class="drawer-kicker">演示版</div>
        <h2 class="drawer-title">设置</h2>
        <p class="drawer-sub">只展示与多 Bot 交互相关的治理项</p>
      </div>
      <button class="icon-btn drawer-close" type="button" data-action="close-drawer" aria-label="关闭">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      <div class="section-label">频道默认</div>
      <ul class="permission-list">
        <li>默认发言节奏<span>一个声音（安静）</span></li>
        <li>进度通知<span>只进摘要</span></li>
        <li>工作室<span>默认关闭</span></li>
      </ul>
      <div class="section-label">审批边界</div>
      <ul class="permission-list">
        <li>外部发送<span>每次批准</span></li>
        <li>购买 / 花费<span>超预算批准</span></li>
        <li>新建 Bot<span>需批准</span></li>
      </ul>
      <div class="empty-state" style="text-align:left;padding:14px 2px 0">这是交互 Demo，设置项不写入持久化存储；正式实现见设计稿 §6.7 与 §19。</div>
    </div>`;
}

/* ── Board ─────────────────────────────────────────────────── */

function openBoard() {
  const ch = currentChannel();
  const columns = [
    ['inbox', '待整理'], ['ready', '待领取'], ['working', '进行中'],
    ['blocked', '阻塞'], ['review', '待验收'], ['done', '完成']
  ];
  const failed = ch.tasks.filter(t => t.status === 'failed');
  const done = ch.tasks.filter(t => t.status === 'done').length;
  $('#boardOverlay').innerHTML = `
    <div class="board-panel" role="dialog" aria-modal="true" aria-label="任务看板">
      <div class="board-head">
        <div class="board-head-copy">
          <div class="board-kicker">任务看板 · ${esc(ch.name)}</div>
          <h2 class="board-title">${esc(ch.goal)}</h2>
        </div>
        <button class="icon-btn" type="button" data-action="close-board" aria-label="关闭看板">${icon('x')}</button>
      </div>
      <div class="board-filter-bar">
        <span class="board-filter-note">${ch.tasks.length} 个任务 · ${done} 个完成</span>
        ${failed.length
          ? `<button class="board-failed-chip" type="button" data-action="board-failed">${icon('alert')} 失败 ${failed.length} · 查看</button>`
          : `<span class="board-failed-chip none">${icon('check')} 无失败任务</span>`}
      </div>
      <div class="board-columns">
        ${columns.map(([status, label]) => {
          const tasks = ch.tasks.filter(t => t.status === status);
          return `<div class="board-column">
            <div class="board-col-head"><span>${label}</span><span class="board-col-count">${tasks.length}</span></div>
            ${tasks.map(task => `
              <button class="board-card ${task.status}" type="button" data-action="open-task" data-task="${task.id}">
                <strong>${esc(task.title)}</strong>
                <small><span>${esc(BOTS[task.owner].name)}</span><span>${task.progress}%</span></small>
              </button>`).join('')}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  $('#boardOverlay').hidden = false;
  requestAnimationFrame(() => $('[data-action="close-board"]', $('#boardOverlay'))?.focus());
}

function closeBoard() {
  $('#boardOverlay').hidden = true;
  $('#boardOverlay').innerHTML = '';
}

/* ── Palette ───────────────────────────────────────────────── */

function commands() {
  return [
    { id: 'c-launch', group: '频道', label: '跳到 发布协作', hint: '# 发布协作', run: () => switchChannel('launch') },
    { id: 'c-growth', group: '频道', label: '跳到 增长实验', hint: '# 增长实验', run: () => switchChannel('growth') },
    { id: 'c-feedback', group: '频道', label: '跳到 客户反馈', hint: '# 客户反馈', run: () => switchChannel('feedback') },
    { id: 'c-inbox', group: '动作', label: '打开收件箱', hint: `${activeInbox().length} 项`, run: () => openDrawer('inbox') },
    { id: 'c-board', group: '动作', label: '打开任务看板', hint: '6 列 + 失败筛选', run: () => openBoard() },
    { id: 'c-studio', group: '动作', label: '切换工作室', hint: '只读视图', run: () => toggleStudio() },
    { id: 'c-bot-yan', group: 'Bot', label: '查看 阿研 的档案', hint: '研究', run: () => openDrawer('bot', 'yan') },
    { id: 'c-bot-an', group: 'Bot', label: '查看 小安 的档案', hint: 'PM', run: () => openDrawer('bot', 'an') },
    { id: 'c-task-risk', group: '任务', label: '打开「评估发布风险」', hint: '进行中', run: () => openDrawer('task', 'risk') }
  ];
}

function openPalette() {
  state.paletteOpen = true;
  state.paletteQuery = '';
  state.paletteIndex = 0;
  $('#paletteOverlay').hidden = false;
  renderPalette();
  requestAnimationFrame(() => $('#paletteInput')?.focus());
}

function closePalette() {
  state.paletteOpen = false;
  $('#paletteOverlay').hidden = true;
  $('#paletteOverlay').innerHTML = '';
}

function renderPalette() {
  const query = state.paletteQuery.trim().toLowerCase();
  const list = commands().filter(c => !query || c.label.toLowerCase().includes(query) || c.group.toLowerCase().includes(query));
  const groups = [...new Set(list.map(c => c.group))];
  let index = 0;
  const body = groups.map(group => {
    const items = list.filter(c => c.group === group);
    return `<div class="palette-group">${group}</div>${items.map(c => {
      const active = index === state.paletteIndex;
      index += 1;
      return `<button class="palette-item ${active ? 'active' : ''}" type="button" data-action="palette-command" data-command="${c.id}">
        <strong>${esc(c.label)}</strong><span>${esc(c.hint || '')}</span>
      </button>`;
    }).join('')}`;
  }).join('');

  $('#paletteOverlay').innerHTML = `
    <div class="palette-panel" role="dialog" aria-modal="true" aria-label="搜索或跳转">
      <div class="palette-input-row">
        ${icon('search')}
        <input class="palette-input" id="paletteInput" type="text" aria-label="搜索频道、任务、Bot 或动作" placeholder="搜索频道、任务、Bot 或动作…" value="${esc(state.paletteQuery)}" autocomplete="off">
        <kbd style="font:500 9px var(--mono);color:#8b97a9;border:1px solid #e0e5ed;border-radius:4px;padding:2px 5px">ESC</kbd>
      </div>
      <div class="palette-list" id="paletteList">${list.length ? body : '<div class="palette-empty">没有匹配项。试试“发布”“任务”或“阿研”。</div>'}</div>
    </div>`;
}

function runCommand(id) {
  const command = commands().find(c => c.id === id);
  if (!command) return;
  closePalette();
  command.run();
}

/* ── Actions ───────────────────────────────────────────────── */

function switchChannel(id) {
  if (!channelById(id)) return;
  state.channel = id;
  state.visited[id] = true;
  state.landed = false;
  state.tab = 'team';
  state.rejecting = null;
  state.studio = false;
  closeRail();
  closeSidebar();
  renderAll();
  announce(`已进入 ${channelById(id).name}`);
}

function toggleStudio() {
  if (!state.studio && window.innerWidth <= 900) {
    announce('工作室视图在桌面端可用');
    return;
  }
  state.studio = !state.studio;
  closeRail();
  renderAll();
  announce(state.studio ? '已打开工作室视图' : '已回到频道');
}

function toggleRail() {
  state.railOpen = !state.railOpen;
  $('#rail').classList.toggle('open', state.railOpen);
  $('#railScrim').hidden = !state.railOpen;
}

function closeRail() {
  state.railOpen = false;
  $('#rail').classList.remove('open');
  $('#railScrim').hidden = true;
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  $('#sidebar').classList.toggle('open', state.sidebarOpen);
  $('#sidebarScrim').hidden = !state.sidebarOpen;
}

function closeSidebar() {
  state.sidebarOpen = false;
  $('#sidebar').classList.remove('open');
  $('#sidebarScrim').hidden = true;
}

function approve(id, mode) {
  const approval = APPROVALS[id];
  if (!approval || approval.status !== 'pending') return;
  approval.status = 'approved';
  approval.mode = mode;
  const ch = channelById('launch');
  ch.messages.push({ type: 'human', text: '批准，注意只看公开页面。', time: nowTime() });
  ch.messages.push({
    type: 'bot', bot: 'yan',
    text: mode === 'once'
      ? '收到，只这一次。我先核对变更记录，10 分钟后给你风险清单。'
      : '收到。我会在本任务内继续使用只读浏览器，先核对变更记录，10 分钟后给你风险清单。',
    time: nowTime()
  });
  renderAll();
  scrollToBottom();
  announce('已批准读取 3 个外部页面');
}

function rejectApproval(id) {
  const approval = APPROVALS[id];
  if (!approval || approval.status !== 'pending') return;
  const textarea = $('#rejectReason');
  const reason = textarea && textarea.value.trim() ? textarea.value.trim() : '先不要读取外部页面';
  approval.status = 'rejected';
  approval.reason = reason;
  state.rejecting = null;
  const ch = channelById('launch');
  ch.messages.push({ type: 'human', text: `拒绝：${reason}`, time: nowTime() });
  ch.messages.push({
    type: 'bot', bot: 'yan',
    text: '收到，我不读取外部页面，改用频道里已有资料；结论会标“未验证”。',
    time: nowTime()
  });
  renderAll();
  announce('已拒绝这次读取');
}

function answerQuestion(id, answer) {
  const question = QUESTIONS[id];
  if (!question || question.status !== 'pending') return;
  question.status = 'answered';
  question.answer = answer;
  const windowTask = findTask('window')?.task;
  if (windowTask) {
    windowTask.status = 'working';
    windowTask.progress = 40;
    windowTask.note = `发布窗口已确认按${answer}；阿研正按这个日期重排风险。`;
    windowTask.steps = [
      { label: '收集窗口信息', done: true },
      { label: `确认窗口：${answer}`, done: true },
      { label: '按窗口重排风险', done: false, current: true }
    ];
  }
  const ch = channelById('launch');
  ch.messages.push({ type: 'human', text: `按${answer}评估。`, time: nowTime() });
  ch.messages.push({
    type: 'bot', bot: 'yan',
    text: `收到，按${answer}重排风险。我会把回滚方案的时间点也对齐到这个窗口。`,
    time: nowTime()
  });
  renderAll();
  announce(`已确认：${answer}`);
}

function acceptArtifact(id) {
  if (ACCEPTED[id]) return;
  ACCEPTED[id] = true;
  const message = CHANNELS.flatMap(ch => ch.messages).find(m => m.id === id);
  const found = message ? findTask(message.task) : null;
  if (found) {
    found.task.status = 'done';
    found.task.progress = 100;
    found.task.note = `${found.task.note} 产物已验收。`;
    found.task.steps = found.task.steps.map(step => ({ ...step, done: true, current: false }));
  }
  renderAll();
  announce('产物已验收，任务完成');
}

function retryFailure(id) {
  if (RETRIED[id]) return;
  RETRIED[id] = true;
  const ch = channelById('growth');
  const found = findTask('write');
  if (found) {
    found.task.status = 'done';
    found.task.progress = 100;
    found.task.note = '2 条记录已重试写入；目标表已对齐，原始回执保留。';
    found.task.steps = [
      { label: '写入 10 条', done: true },
      { label: '2 条被拒绝', done: true },
      { label: '重试并写入 2 条', done: true }
    ];
  }
  ch.messages.push({ type: 'system', text: '你重试了 2 条记录；写入成功', time: nowTime() });
  ch.messages.push({ type: 'bot', bot: 'xie', text: '重试完成：2 条记录已写入，目标表已对齐。原始回执保留在任务证据里。', time: nowTime() });
  renderAll();
  announce('重试成功，2 条记录已写入');
}

function gotoInboxItem(id) {
  const item = activeInbox().find(i => i.id === id);
  if (!item) return;
  closeDrawer();
  if (state.channel !== item.channel || state.studio) {
    state.channel = item.channel;
    state.visited[item.channel] = true;
    state.studio = false;
    state.tab = 'team';
    renderAll();
  }
  state.pendingFocus = item.focus;
  renderStream();
  setTimeout(() => {
    if (state.pendingFocus) {
      focusEvent(state.pendingFocus);
      state.pendingFocus = null;
    }
  }, 140);
}

function focusEvent(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1700);
}

function mentionBot(id) {
  closeDrawer();
  if (state.studio) {
    state.studio = false;
    renderAll();
  }
  const input = $('#composerInput');
  if (!input) return;
  input.value = `@${BOTS[id].name} `;
  input.focus();
  input.dispatchEvent(new Event('input'));
}

function sendMessage() {
  const input = $('#composerInput');
  const text = input.value.trim();
  if (!text) return;
  const ch = currentChannel();
  ch.messages.push({ type: 'human', text, time: nowTime() });
  input.value = '';
  input.style.height = 'auto';
  state.thinking = { channel: ch.id, bot: 'an' };
  renderStream();
  scrollToBottom();
  announce('消息已发送');

  setTimeout(() => {
    if (!state.thinking || state.thinking.channel !== ch.id) return;
    state.thinking = null;
    const risk = /风险|发布|回滚/.test(text);
    ch.messages.push({
      type: 'bot', bot: 'an',
      text: risk
        ? '收到。我让阿研核对变更记录，阿写同步整理发布说明。两件事，预计 15 分钟。'
        : '收到。我先确认目标和资料，再分给对应的 Bot。预计 10 分钟。',
      time: nowTime()
    });
    const task = {
      id: `t${Date.now()}`,
      title: text.length > 16 ? `${text.slice(0, 16)}…` : text,
      status: 'working',
      owner: risk ? 'yan' : 'an',
      progress: 8,
      budget: '6k',
      used: '0',
      evidence: 0,
      deps: '—',
      note: '从频道消息创建；front-door 已确认范围，等待第一个 Bot 接手。',
      steps: [
        { label: '确认目标与范围', done: false, current: true },
        { label: '分派给合适的 Bot', done: false },
        { label: '执行并回报', done: false }
      ]
    };
    ch.tasks.push(task);
    if (task.owner !== 'an') {
      ch.messages.push({ type: 'handoff', id: `ho-${task.id}`, from: 'an', to: task.owner, task: task.id, time: nowTime() });
    }
    ch.messages.push({ type: 'task', task: task.id, time: nowTime() });
    if (state.channel === ch.id) {
      renderAll();
      scrollToBottom();
      announce('小安已拆解并创建任务');
    }
  }, 950);
}

/* ── Render all ────────────────────────────────────────────── */

function renderAll() {
  renderSidebar();
  renderHeader();
  renderStream();
  renderRail();
  renderStudio();
  $('#content').hidden = state.studio;
  $('#studio').hidden = !state.studio;
  syncIcons();
  if (state.pendingFocus) {
    const id = state.pendingFocus;
    setTimeout(() => focusEvent(id), 120);
  }
  if (!state.settled) {
    state.settled = true;
    setTimeout(() => $('#app').classList.add('settled'), 700);
  }
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    const stream = $('#stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  });
}

/* ── Events ────────────────────────────────────────────────── */

document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case 'switch-channel':
      switchChannel(target.dataset.channel);
      break;
    case 'direct-an':
      switchChannel('launch');
      openDrawer('bot', 'an');
      break;
    case 'open-inbox':
      openDrawer('inbox');
      break;
    case 'open-bot':
      openDrawer('bot', target.dataset.bot);
      break;
    case 'open-task':
      closeBoard();
      openDrawer('task', target.dataset.task);
      break;
    case 'open-board':
      openBoard();
      break;
    case 'board-failed':
      closeBoard();
      openDrawer('failed');
      break;
    case 'close-board':
      closeBoard();
      break;
    case 'close-drawer':
      closeDrawer();
      break;
    case 'tab':
      state.tab = target.dataset.tab;
      renderRail();
      break;
    case 'toggle-studio':
      toggleStudio();
      break;
    case 'toggle-rail':
      toggleRail();
      break;
    case 'toggle-sidebar':
      toggleSidebar();
      break;
    case 'approve':
      approve(target.dataset.approval, target.dataset.decision);
      break;
    case 'reject':
      state.rejecting = target.dataset.approval;
      renderStream();
      setTimeout(() => $('#rejectReason')?.focus(), 40);
      break;
    case 'confirm-reject':
      rejectApproval(target.dataset.approval);
      break;
    case 'cancel-reject':
      state.rejecting = null;
      renderStream();
      break;
    case 'answer':
      answerQuestion(target.dataset.question, target.dataset.answer);
      break;
    case 'accept-artifact':
      acceptArtifact(target.dataset.artifact);
      break;
    case 'retry-failure':
      retryFailure(target.dataset.failure);
      break;
    case 'inbox-filter':
      state.inboxFilter = target.dataset.filter;
      $('#drawer').innerHTML = renderInboxDrawer();
      syncIcons($('#drawer'));
      break;
    case 'goto':
      gotoInboxItem(target.dataset.item);
      break;
    case 'bot-directory':
      openDrawer('directory');
      break;
    case 'settings':
      openDrawer('settings');
      break;
    case 'mention-bot':
      mentionBot(target.dataset.bot);
      break;
    case 'open-palette':
      openPalette();
      break;
    case 'palette-command':
      runCommand(target.dataset.command);
      break;
    case 'replay':
      state.replaying = true;
      renderStudio();
      setTimeout(() => {
        state.replaying = false;
        if (state.studio) renderStudio();
      }, 2800);
      break;
    case 'insert-at': {
      const input = $('#composerInput');
      if (!input) return;
      input.focus();
      const start = input.selectionStart || input.value.length;
      input.value = `${input.value.slice(0, start)}@${input.value.slice(start)}`;
      input.setSelectionRange(start + 1, start + 1);
      input.dispatchEvent(new Event('input'));
      break;
    }
    default:
      break;
  }
});

// Close overlays by clicking their backdrop.
$('#scrim').addEventListener('click', closeDrawer);
$('#railScrim').addEventListener('click', closeRail);
$('#sidebarScrim').addEventListener('click', closeSidebar);
$('#boardOverlay').addEventListener('click', event => {
  if (event.target === $('#boardOverlay')) closeBoard();
});
$('#paletteOverlay').addEventListener('click', event => {
  if (event.target === $('#paletteOverlay')) closePalette();
});

// Composer
$('#composerForm').addEventListener('submit', event => {
  event.preventDefault();
  sendMessage();
});

$('#composerInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

$('#composerInput').addEventListener('input', event => {
  const el = event.target;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
});

// Palette input & keyboard
document.addEventListener('input', event => {
  if (event.target.id !== 'paletteInput') return;
  state.paletteQuery = event.target.value;
  state.paletteIndex = 0;
  renderPalette();
  const input = $('#paletteInput');
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
});

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (state.paletteOpen) closePalette();
    else openPalette();
    return;
  }

  if (event.key === 'Escape') {
    if (state.paletteOpen) { closePalette(); return; }
    if (!$('#boardOverlay').hidden) { closeBoard(); return; }
    if (state.drawer) { closeDrawer(); return; }
    if (state.railOpen) { closeRail(); return; }
    if (state.sidebarOpen) { closeSidebar(); return; }
    if (state.rejecting) { state.rejecting = null; renderStream(); }
    return;
  }

  if (state.paletteOpen) {
    const items = $$('.palette-item');
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.paletteIndex = Math.min(state.paletteIndex + 1, items.length - 1);
      renderPalette();
      const input = $('#paletteInput');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.paletteIndex = Math.max(state.paletteIndex - 1, 0);
      renderPalette();
      const input = $('#paletteInput');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const active = $('.palette-item.active') || items[0];
      if (active) active.click();
    }
  }
});

// Initial route hints for screenshots / deep links.
(function init() {
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel');
  if (channel && channelById(channel)) {
    state.channel = channel;
    state.visited[channel] = true;
  }
  if (['team', 'tasks', 'files'].includes(params.get('tab'))) state.tab = params.get('tab');
  if (params.get('studio') === '1' && window.innerWidth > 900) state.studio = true;
  renderAll();
  if (params.get('inbox') === '1') openDrawer('inbox');
  if (params.get('board') === '1') openBoard();
  if (params.get('drawer') === 'task') openDrawer('task', 'risk');
  if (params.get('drawer') === 'bot') openDrawer('bot', 'yan');
})();