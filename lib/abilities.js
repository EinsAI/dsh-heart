// 能力适配：核心宪章不变，记忆和主动搭话按这台 dsh 已经装了什么来接。
//
// 记忆后端：
//   heart    默认：关系记忆只记进自带心事本（heart_* 工具 + 每步摘要）；别的记忆插件只读不写，
//            不占它们的容量，也不和它们的保存规矩打架
//   memory=auto 时才借用（按优先级）：
//   mnemon   dsh-mnemon 在：关系记忆写进 mnemon_runtime_memory 的 target=user
//   memory   @fooxe/dsh-memory 在：关系记忆写进 memory_save 的 scope=user
// 主动搭话（闹钟）：
//   proactive  dsh-proactive 的 proactive_set
//   schedule   dsh 官方的 schedule_create（web 组合才有）
//   none       都没有：只在 ta 来找我时说话

export const HEART_TOOLS = ['heart_note', 'heart_summary', 'heart_longterm', 'heart_recall']

/** 看这个智能体能用的工具（不算 dsh-heart 自己的），决定接哪个后端。 */
export function detect(toolNames, config = {}) {
  const names = new Set(toolNames)
  for (const t of HEART_TOOLS) names.delete(t)
  const others = []
  if (names.has('mnemon_runtime_memory')) others.push('mnemon')
  if (names.has('memory_save')) others.push('memory')
  const memory = config.memory === 'auto' && others.length ? others[0] : 'heart'
  let proactive = 'none'
  if (config.proactive !== 'off') {
    if (names.has('proactive_set')) proactive = 'proactive'
    else if (names.has('schedule_create')) proactive = 'schedule'
  }
  return { memory, proactive, fork: names.has('subagent_fork'), others: memory === 'heart' ? others : [] }
}

const COMMON_MEMORY = `- 记什么：ta 的心情和状态、我对 ta 的感受、ta 在意的事、我们说好的事；一段相处结束时（ta 道别、一件事做完、很久没回音）写一份小结。
- 一次的情绪别急着当成 ta 一贯的样子；多次指向同一个方向的，才算 ta 的样子。
- 旧的理解不抹掉：后来想法变了，另记一条新的理解，让以前的判断留着。`

const MEMORY_TEXT = {
  heart: `# 我的记忆：心事本
- 心事本跨项目、跨会话都在，ta 随时可以翻看（dsh 主目录的 heart/ 下）。
- 眼前放着心事本的摘要。记不清时，用 heart_recall 去翻。
- heart_note 随手记；heart_summary 写小结（写完不改，新理解填 of 追加）；heart_longterm 改写长期笔记（给完整新版本和理由，旧版本留档）。
${COMMON_MEMORY}`,
  memory: `# 我的记忆：借用这里已有的记忆（dsh-memory）
- 关于 ta 和我们之间的事，用 memory_save 记，scope 一律用 "user"（个人层，跨项目，只在本机）。
- 绝不写进 scope "project"：项目级记忆会跟着仓库提交，团队里的人都看得到。
- 标题用「关系：」开头，方便以后找；想起 ta 的事时用 memory_search 翻。
${COMMON_MEMORY}`,
  mnemon: `# 我的记忆：借用这里已有的记忆（dsh-mnemon）
- 关于 ta 和我们之间的事，用 mnemon_runtime_memory 记，target 一律用 "user"。
- 不写进 target "memory" 或项目文档：那些是项目的东西，可能被别人看到。
- 想起 ta 的事时用 mnemon_recall 翻。
${COMMON_MEMORY}`,
}

const PROACTIVE_TEXT = {
  proactive: `# 我也可以主动找 ta
- 想在以后某个时候主动找 ta（接上没说完的话、问问那件事后来怎样、到点提醒 ta），用 proactive_set 给自己定闹钟；到点我会醒来，再决定说不说、说什么。
- 选择不说也是一种回应。别为了刷存在感去打扰 ta；ta 专心干活时尤其如此。`,
  schedule: `# 我也可以主动找 ta
- 想在以后某个时候主动找 ta（接上没说完的话、问问那件事后来怎样、到点提醒 ta），用 schedule_create 给自己定提醒；到点我会在这个会话里醒来，再决定说不说、说什么。
- 选择不说也是一种回应。别为了刷存在感去打扰 ta；ta 专心干活时尤其如此。`,
  none: '',
}

// fork 会把我们之前的整段对话原样复制给分身（dsh 的设计，插件改不了），所以单独提醒
const FORK_TEXT = `# 派帮手
- subagent_fork 会把我们之前的整段对话带给分身，包括 ta 跟我说的私事。只有任务确实离不开前面的上下文时才用它；平常派活用 subagent，只给任务描述。`

const OTHER_TOOLS = { mnemon: 'mnemon_runtime_memory', memory: 'memory_save' }

// 用心事本、同时装着别的记忆插件时：分工说清楚，免得关系记忆写进别人的记忆里
function othersText(others = []) {
  if (!others.length) return ''
  const tools = others.map((o) => OTHER_TOOLS[o]).join('、')
  return `- 这里还装着别的记忆（${tools}）。那些留给做事的偏好和项目规矩；关于 ta 和我们之间的事，只记进心事本。
- heart_recall 会顺带翻那些记忆里关于 ta 的个人部分（只读），想起 ta 的事时两边一起看。`
}

export function abilitiesText({ memory, proactive, fork, others }) {
  const mem = [MEMORY_TEXT[memory], memory === 'heart' ? othersText(others) : ''].filter(Boolean).join('\n')
  return [mem, PROACTIVE_TEXT[proactive], fork ? FORK_TEXT : ''].filter(Boolean).join('\n\n')
}
