/**
 * The public privacy page, `/privacy`. It needs no sign-in: Google's consent screen links to it, and someone deciding
 * whether to sign in reads it first. Every line describes what this code stores and who can read it; when a store
 * changes, change this page in the same pull request.
 */
export interface PrivacyPageOptions {
  /** Who to write to about this deployment's data, usually an email address. `AEEIS_PRIVACY_CONTACT`. */
  contact?: string | undefined;
  /** How many days encrypted backups are kept. `AEEIS_BACKUP_KEEP_DAYS`. */
  backupDays?: number | undefined;
  /** Whether this deployment seals content with per-tenant keys (PostgreSQL with a content key). */
  encrypted?: boolean | undefined;
  /** Last change to this text, shown at the top. */
  updated?: string;
}

export const PRIVACY_UPDATED = '2026-11-27';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function privacyPage(options: PrivacyPageOptions & { signIn?: 'google' | 'token' } = {}): string {
  const contact = options.contact?.trim();
  // Cloudflare's email obfuscation would turn the address into "[email protected]" for anyone without JavaScript,
  // including reviewers; email_off leaves this one address as written and the rest of the site protected.
  const contactHtml = contact
    ? (/^[^\s@<>"']+@[^\s@<>"']+$/.test(contact) ? `<!--email_off--><a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a><!--/email_off-->` : escapeHtml(contact))
    : '运行这个 AEEIS 的管理员';
  const backup = options.backupDays && Number.isFinite(options.backupDays) && options.backupDays > 0
    ? `加密备份保留 ${Math.round(options.backupDays)} 天，到期自动删除；删除的内容最晚在这之后从备份里消失。`
    : '如果部署做了备份，删除的内容要等备份到期才会从备份里消失。';
  const updated = escapeHtml(options.updated ?? PRIVACY_UPDATED);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AEEIS 隐私说明</title>
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/privacy.css">
</head>
<body class="privacy-page">
<main>
<p class="privacy-back"><a href="/">返回 AEEIS</a></p>
<h1>AEEIS 隐私说明</h1>
<p class="muted">更新于 ${updated}。不登录也能看这一页。</p>

<p>AEEIS 是一个让你和自己的 Bot 对话、让它们替你做事的工作区。这一页说明它存了你什么、谁能看见、怎么删。有问题请联系 ${contactHtml}。</p>

<h2 id="google">从 Google 拿到什么</h2>
<p>用 Google 登录时，AEEIS 只请求 <code>openid</code>、<code>email</code> 和 <code>profile</code>，拿到的是：</p>
<ul>
<li>你的邮箱地址和 Google 账号编号：用来确认你在允许登录的名单里（或属于允许的 Google Workspace 域），并认出是你。</li>
<li>你在 Google 上的名字：只用来在成员列表、档案页和群聊里称呼你。管理员可以另给你起一个显示名，有显示名时用显示名。</li>
</ul>
<p>AEEIS 不读你的 Gmail、通讯录、日历或云端硬盘，也不保存 Google 的访问令牌：登录完成后只留下一个由 AEEIS 签名的登录 Cookie（默认 7 天有效）。从 Google 拿到的信息不卖给任何人，不用于广告，也不拿去训练模型；只在提供 AEEIS 本身需要时使用，遵守 <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API 服务用户数据政策</a>（包括其中的「有限使用」要求）。</p>

<h2 id="stored">存了什么</h2>
<p>数据都按「你是谁 + 你在哪个租户」分开存。下面是会存下的东西：</p>
<ul>
<li><strong>成员信息</strong>：本租户成员的邮箱、Google 名字、管理员给的显示名、第一次和最近一次登录时间。</li>
<li><strong>对话</strong>：你和每位 Bot 的一对一消息、它们的回复、从对话里记下的任务和每件任务的工作记忆；你和 Bot 的未读位置和对话摘要。</li>
<li><strong>群聊</strong>：群里的消息、任务卡片、成员和各自的角色（主人、编辑、只读）。</li>
<li><strong>Bot</strong>：你建的 Bot 的名字、角色、背景、常驻嘱咐、自主程度，Bot 之间谈交接的侧线程，以及例程和提醒的设置与送达记录。</li>
<li><strong>Brain（长期记忆）</strong>：你明确记下或批准记下的事实、决定和偏好，以及读取它们的审计记录。</li>
<li><strong>Run 记录和回执</strong>：每次执行的计划、步骤、工具调用、产出、用到的资料的哈希、花了多少 token 和钱，以及审批、授权和动作清单（允许、阻止）的记录。</li>
<li><strong>上传的资料和产出</strong>：你给一次 Run 的文本和文件（例如 PDF、CSV）、它生成的文件和网页预览。用 Bot 电脑时，工作文件放在那次 Run 专用的隔离机器里，Run 结束后机器释放，除非你选择保留。</li>
<li><strong>额度</strong>：按租户统计的模型和工具用量，用来在超额前停下。</li>
<li><strong>设备和通知</strong>：登录过的设备、你开启的推送订阅地址，以及页面上几个操作的按天计数（只有操作名、群聊和日期，没有内容）。</li>
</ul>

<h2 id="encryption">怎么保护</h2>
<ul>
${options.encrypted
    ? `<li>每个租户有自己的数据密钥。存进数据库的对话、群聊、Run 记录、Brain 和成员信息用这把密钥加密；数据密钥本身再用服务器上的主密钥加密保存。</li>
<li>数据库按租户做了行级隔离：一个租户的请求读不到另一个租户的行。</li>`
    : '<li>这台部署没有开启内容加密：数据存在服务器磁盘上，靠磁盘加密和服务器的访问控制保护。</li>'}
<li>${escapeHtml(backup)}</li>
</ul>

<h2 id="who">谁能看见</h2>
<ul>
<li><strong>你和 Bot 的一对一对话、你的 Brain、你的 Run</strong>：只有你。同一租户的其他人看不到。</li>
<li><strong>群聊</strong>：这个群的成员。被移出的人不再能看。</li>
<li><strong>分享链接</strong>：拿到链接的任何人，直到你撤销这个链接。</li>
<li><strong>成员列表</strong>：同一租户的人能看到你的名字、邮箱和最近登录时间，以及你和他们共同所在的群聊。看不到你的对话。</li>
<li><strong>其他租户</strong>：什么都看不到。</li>
<li><strong>模型和工具服务商</strong>：Bot 回答或执行时，对话、资料和群聊里的发言（包括发言人的显示名或 Google 名字）会发给管理员配置的模型服务商；用网页搜索、网页读取这类工具时，查询会发给对应的服务。它们按各自的条款处理这些内容。</li>
<li><strong>管理员</strong>：运行这台服务器的人掌握主密钥，技术上能接触到数据。他们只为运维、排查故障或按你的要求删除数据时这样做。</li>
</ul>

<h2 id="delete">怎么删</h2>
<p>你自己可以在页面上做这些：</p>
<ul>
<li>撤下一位 Bot：它不再回复和执行，和它的对话留作只读历史。</li>
<li>撤销分享链接、删除例程、关掉推送通知、退出登录。</li>
<li>把别人移出你建的群聊。</li>
</ul>
<p>要彻底删除你的对话、群聊、Brain、Run 记录、上传的资料或成员信息，请联系 ${contactHtml}，说明要删什么（或全部）。管理员会从数据库删除，并停止你的登录。${escapeHtml(backup)}</p>

<h2 id="changes">改动</h2>
<p>这一页随 AEEIS 存的东西一起改。改动后页首日期会更新。</p>
</main>
</body>
</html>
`;
}
