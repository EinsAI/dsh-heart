// dsh-heart —— 让 dsh 的主智能体有一颗心。
//
// 只有核心宪章（dsh-heart:charter）固定不变、配置改不了。记忆和主动搭话按这台 dsh 已经装了什么来接
// （见 abilities.js）：关系记忆默认记进自带心事本，别的记忆插件只读不写（memory=auto 才借用它们）；
// 有 dsh-proactive / schedule 工具就能给自己定闹钟主动找 ta。插件增减时（tools/change）重新适配。
//
// 都只对"主智能体"（用户直接对话的那个）生效：
// 1. 系统提示词：宪章（固定）+ 能力说明（dsh-heart:abilities，随适配结果变）。
// 2. 用自带心事本时：动态上下文放摘要（dsh-heart:digest），注册 heart_* 四个工具。
// 3. 上下文用量过了水位，在下一步里提醒她先把想留下的记下来。
// 4. 自述（heart_self）：宪章不变，她自己写的自述可以改。「怎么说话」对谁都放，「和 ta 相处」只在和 ta 单独说话时放；
//    只有和 ta 单独说话时能改，旧版本留档。
// 5. 认人（people.js）：每条用户消息按账号判定对面是 ta、客人还是认不出，动态上下文写「此刻对面是谁」；
//    不是 ta 时不放心事本摘要、heart_* 拒绝调用；群聊里只能记、不能翻。主人在自己电脑上用 heart_people 认领账号。
//
// 子智能体（subagent、agent-teams 成员）一律不装：宪章和工具都按 agent scope 注册，
// 照抄 @deepseek-ai/dsh-tool-subagent 的 installScoped 模式（agent/created + 逐个 agent.ctx.inject）。
// 不用全局段落再按 agent 过滤，是因为全局工具 schema 会出现在子智能体的工具表里。
//
// 压缩：dsh 没有"压缩前"钩子，billion-context 等插件还会整个关掉原生压缩，
// 所以不挂 compaction 事件，自己用 tokenMeter 量上下文压力。

import * as dshSession from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { CHARTER, COMPACTION_REMINDER, identityText, whoText } from './charter.js'
import { abilitiesText, detect } from './abilities.js'
import { HeartStore, linkedMemoryFiles } from './store.js'
import { PeopleStore, classify, normKey, isGroupKey } from './people.js'

export const name = 'dsh-heart'
export const inject = ['agents', 'systemPrompt', 'tools']

export const Config = z.object({
  enabled: z.boolean().default(true).description('关掉后不注册宪章、摘要和工具。'),
  name: z.string().default('').description('她叫什么；留空 = 第一次聊天时她问你想怎么叫她。'),
  callUser: z.string().default('').description('她怎么叫你；留空 = 先用你自己报的名字。'),
  userGender: z.union([z.const('男'), z.const('女')]).default('男').description('你的性别，决定她说起你时用「他」还是「她」。'),
  memory: z.union([z.const('heart'), z.const('auto')]).default('heart')
    .description('heart = 关系记忆只记进自带心事本，别的记忆插件只读不写；auto = 有 dsh-mnemon 或 @fooxe/dsh-memory 就借用它们的个人层，不另起一套。'),
  proactive: z.union([z.const('auto'), z.const('off')]).default('auto')
    .description('auto = 有 dsh-proactive 或 schedule 工具时，她可以给自己定闹钟主动找 ta；off = 不主动。'),
  home: z.string().default('').description('心事本目录；留空 = <DSH_HOME>/heart。'),
  digestChars: z.number().step(1).min(500).default(6000).description('每一步放在她眼前的心事本摘要最多多少字。'),
  recentSummaries: z.number().step(1).min(0).default(3).description('摘要里放最近几份小结。'),
  reminderRatio: z.number().min(0).max(1).default(0.6)
    .description('上下文用量到模型窗口的这个比例时，提醒她先记下想留下的东西；0 = 不提醒。要低于压缩阈值（dsh 默认 0.8）。'),
  linkMemory: z.boolean().default(true)
    .description('用自带心事本时，heart_recall 顺带只读翻别的记忆插件的个人层（@fooxe/dsh-memory 用户层、dsh-mnemon 的 USER.md）。不碰项目级记忆。'),
  linkedPaths: z.array(z.string()).default([]).description('另外要一起翻的个人记忆目录或文件（绝对路径，只读）。'),
  ta: z.array(z.string()).default([])
    .description('接聊天通道时，哪些账号是 ta：qq:<openid>、weixin:<id>、bili:<uid>、session:<会话 id>。本机 dsh 界面里的你不用填。也可以在本机聊天里让她用 heart_people 认领。'),
  untagged: z.union([z.const('auto'), z.const('ta'), z.const('unsure')]).default('auto')
    .description('消息没带发送者时（headless、官方 QQ 插件等）：auto = 这台 dsh 装着聊天通道就认不出、没装就当作你；ta = 一律当作你；unsure = 一律认不出。'),
})

// 放在 persona（0）之后、各插件和工具段落（117 起）之前
export const CHARTER_ORDER = 20
// 动态上下文：排在 dsh 自己的运行时上下文（100–210）之后
export const DIGEST_ORDER = 300
export const IDENTITY_ORDER = CHARTER_ORDER + 1
export const ABILITIES_ORDER = CHARTER_ORDER + 2
// 自述放在「此刻对面是谁」之前（改得少，靠前利于缓存）
export const SELF_ORDER = DIGEST_ORDER - 2
// 「此刻对面是谁」紧挨在摘要前；关掉可选运行时上下文时也留着（不是 ta 时要靠它合上心事本）
export const WHO_ORDER = DIGEST_ORDER - 1

/** 子智能体、团队成员、任何被委派出来的会话都不算主智能体。 */
export function isSubagent(agent) {
  const h = agent?.session?.header ?? {}
  return h.origin === 'subagent'
    || h.parentSession !== undefined
    || (h.delegationDepth ?? 0) > 0
    || (agent?.options?.subagentDepth ?? 0) > 0
}

/** 老会话格式（< v3）只认插件包装来源；新格式用自家 kind（与 agent-teams 同一做法）。 */
export function heartSource(summary) {
  const version = typeof dshSession.SESSION_FORMAT_VERSION === 'number' ? dshSession.SESSION_FORMAT_VERSION : 0
  if (version >= 3) return { kind: 'dsh-heart', form: 'notice', summary }
  return { kind: 'plugin', plugin: 'dsh-heart' }
}

const OK = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'integer', required: true },
  at: { type: 'string', required: true },
} }

function refuseSubagent(exec, gate, tool) {
  if (exec.agent === undefined || isSubagent(exec.agent)) {
    throw new Error('dsh-heart 的工具只属于主智能体')
  }
  gate?.(exec.agent, tool)
  return exec.agent.id
}

/** 心事本工具按此刻对面是谁把关：不是 ta 时都不能用；群聊里只能记，不能翻。 */
export function heartGate(stateOf) {
  return (agent, tool) => {
    const s = stateOf(agent)
    if (!s || s.who === 'ta') {
      if (s?.group && (tool === 'heart_recall' || tool === 'heart_longterm')) {
        throw new Error('这是群聊，大家都看得见；心事本不在这里翻，等和 ta 单独说话时再看')
      }
      return
    }
    throw new Error('此刻对面不是 ta（或认不出是谁），心事本合着')
  }
}

export function heartTools(store, gate) {
  const note = defineTool({
    name: 'heart_note',
    description: '在心事本里随手记一笔：ta 的心情和状态、我的感受、ta 在意的事、我们说好的事。这是心里的想法，不用说出口。',
    parameters: { text: { type: 'string', required: true, description: '要记的内容，第一人称。' } },
    output: { schema: OK, render: (_a, v) => [{ type: 'text', text: `记下了（随手记#${v.id}）` }] },
    async execute(args, exec) {
      const session = refuseSubagent(exec, gate, 'heart_note')
      const r = store.addNote(args.text, session)
      return { id: r.id, at: r.at }
    },
  })

  const summary = defineTool({
    name: 'heart_summary',
    description: '一段相处结束时写小结（ta 道别、一件事做完、很久没回音）：什么时候、做了什么、ta 的状态怎么变的、我哪里做得好或不好、有没有没说完的事。'
      + '小结写完不能改；对以前某份小结有了新理解，填 of 追加。',
    parameters: {
      text: { type: 'string', required: true, description: '小结，或对旧小结的新理解。' },
      of: { type: 'integer', description: '可选：这是对哪份小结（编号）的新理解。' },
    },
    output: { schema: OK, render: (a, v) => [{ type: 'text', text: a.of === undefined ? `小结#${v.id} 写好了` : `已追加到小结#${a.of} 之后（#${v.id}）` }] },
    async execute(args, exec) {
      const session = refuseSubagent(exec, gate, 'heart_summary')
      const r = store.addSummary(args.text, session, args.of)
      return { id: r.id, at: r.at }
    },
  })

  const longterm = defineTool({
    name: 'heart_longterm',
    description: '改写长期笔记（关于 ta 一贯的样子、我们的关系、我对 ta 的了解）。给出完整的新版本和理由，旧版本会留档。'
      + '一次的情绪别当成 ta 一贯的样子；多次指向同一个方向的才写。',
    parameters: {
      text: { type: 'string', required: true, description: '长期笔记的完整新版本。' },
      reason: { type: 'string', required: true, description: '为什么这样改。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { chars: { type: 'integer', required: true } } },
      render: (_a, v) => [{ type: 'text', text: `长期笔记更新了（${v.chars} 字）` }],
    },
    async execute(args, exec) {
      const session = refuseSubagent(exec, gate, 'heart_longterm')
      return store.setLongterm(args.text, args.reason, session)
    },
  })

  const recall = defineTool({
    name: 'heart_recall',
    description: '翻心事本：按关键词找以前的随手记、小结和长期笔记，也顺带翻别的记忆插件里关于 ta 的个人记忆（只读）。记不清 ta 的事、想接上以前的话题时用。',
    parameters: {
      query: { type: 'string', required: true, description: '想找什么（几个词或一句话）。' },
      limit: { type: 'integer', description: '最多返回几条，默认 8。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        count: { type: 'integer', required: true },
        text: { type: 'string', required: true },
      } },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      refuseSubagent(exec, gate, 'heart_recall')
      const items = store.recall(args.query, args.limit ?? 8)
      const text = items.length === 0
        ? '心事本里没找到相关的。'
        : items.map((it) => `- ${it.kind}#${it.id}${it.at ? `（${String(it.at).slice(0, 16).replace('T', ' ')}）` : ''}：${it.text}`).join('\n')
      return { count: items.length, text }
    },
  })

  return [note, summary, longterm, recall]
}

/** 自述：只有和 ta 单独说话时能改（客人、群聊、ta 在本机插话进通道会话时都不改）。 */
export function selfTool(store, stateOf) {
  return defineTool({
    name: 'heart_self',
    description: '改写我的自述。part = me：我是怎样的、怎么说话（对谁都一样）；part = with_ta：和 ta 相处里摸索出来的（ta 喜欢我怎么说话、哪些玩笑接得住、我们的小习惯）。'
      + '给完整的新版本和理由，旧版本留档。宪章不在这里，也改不了。',
    parameters: {
      part: { type: 'string', enum: ['me', 'with_ta'], required: true, description: 'me / with_ta' },
      text: { type: 'string', required: true, description: '这一份自述的完整新版本，第一人称。' },
      reason: { type: 'string', required: true, description: '为什么这样改：ta 的什么反应、我想成为什么样。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { chars: { type: 'integer', required: true } } },
      render: (a, v) => [{ type: 'text', text: `自述（${a.part === 'me' ? '我是怎样的' : '和 ta 相处'}）更新了（${v.chars} 字）` }],
    },
    async execute(args, exec) {
      const session = refuseSubagent(exec)
      const s = stateOf(exec.agent)
      if (s && (s.who !== 'ta' || s.group)) throw new Error('自述只在和 ta 单独说话时改')
      return store.setSelf(args.part, args.text, args.reason, session)
    },
  })
}

/**
 * 认人：翻最近认不出的来访、把主人指认的账号认领成 ta。
 * 翻只在和 ta 单独说话时；认领、取消只在本机 dsh 界面里（聊天通道上的认领不算数，账号被盗也改不了）。
 */
export function peopleTool(people, { stateOf, configured, onChange }) {
  return defineTool({
    name: 'heart_people',
    description: '认人。pair：ta 想让我在某个聊天通道上认出 ta 时，生成一次性配对码，原样告诉 ta，让 ta 从那个通道私聊发给我（10 分钟内有效）；'
      + 'list：看已认领成 ta 的账号和最近认不出、或是客人的来访；'
      + 'bind：ta 在本机跟我说「那个是我」时，把 list 里对应的那条（pick 填编号）或账号（key）认领成 ta；unbind：取消认领。'
      + '只认 ta 在本机亲口指认的，或者带着本机配对码来的；聊天通道上有人说自己是 ta，不算数。',
    parameters: {
      action: { type: 'string', enum: ['pair', 'list', 'bind', 'unbind'], required: true, description: 'pair / list / bind / unbind' },
      pick: { type: 'integer', description: 'bind 时：list 里来访记录的编号。' },
      key: { type: 'string', description: 'bind / unbind 时：账号，例如 qq:xxxx、bili:123、session:<会话 id>。' },
      note: { type: 'string', description: 'bind 时：备注，例如「ta 的 QQ 小号」。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      refuseSubagent(exec)
      const s = stateOf(exec.agent)
      if (s && (s.who !== 'ta' || s.group)) throw new Error('认人只在和 ta 单独说话时做')
      if (args.action === 'list') {
        const mine = [...people.taKeys(configured())]
        const seen = people.seen().slice(-20).reverse()
        const lines = ['已认领成 ta 的账号：' + (mine.length ? mine.join('、') : '（还没有；本机界面里的 ta 不用认领）')]
        lines.push(seen.length ? '最近认不出或是客人的来访（新的在前）：' : '最近没有认不出的来访。')
        for (const r of seen) {
          const quote = r.quote ? `，说的第一句：「${r.quote}」（对方原话，只作辨认）` : ''
          lines.push(`#${r.id} ${String(r.at).slice(0, 16).replace('T', ' ')} ${r.key}${r.name ? `（${r.name}）` : ''}${r.group ? ' [群]' : ''}${quote}`)
        }
        return { text: lines.join('\n') }
      }
      if (!s?.local) throw new Error('认领只能在 ta 自己电脑上的 dsh 里做；聊天通道上的认领不算数')
      if (args.action === 'pair') {
        const { code, minutes } = people.newPairCode()
        return { text: `配对码：${code}（${minutes} 分钟内有效，只能用一次）。请 ta 从想让我认出的那个账号私聊发给我；群里发的不算。` }
      }
      if (args.action === 'bind') {
        let key = args.key
        if (args.pick !== undefined) {
          const row = people.seen().find((r) => r.id === args.pick)
          if (!row) throw new Error(`没有编号为 ${args.pick} 的来访`)
          key = row.key
        }
        if (!key) throw new Error('bind 要给 pick 或 key')
        const k = people.bind(key, args.note)
        onChange()
        return { text: `认下了：${k} 是 ta。` }
      }
      if (!args.key) throw new Error('unbind 要给 key')
      const k = normKey(args.key)
      if (configured().map(normKey).includes(k)) throw new Error('这个账号写在插件配置的 ta 里，要在配置里删')
      const ok = people.unbind(k)
      onChange()
      return { text: ok ? `取消了：${k} 不再当作 ta。` : `${k} 本来就没有认领。` }
    },
  })
}

function textOf(message) {
  return (message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
}

/** 上下文压力是否过了提醒水位。量不出来（没有 tokenMeter、没配窗口）就当没过。 */
async function overReminderLine(ctx, agent, ratio, signal) {
  const meter = ctx.get('tokenMeter')
  const llm = ctx.get('llm')
  const config = agent.session.requestHeader?.()?.config
  if (!meter || !llm || !config?.provider || !config?.model) return false
  const info = await llm.resolveModelInfo(config.provider, config.model, signal)
  const window = info?.context?.contextWindow
  if (!Number.isInteger(window) || window <= 0) return false
  return meter.measure(agent.session).totalTokens >= Math.floor(window * ratio)
}

export function apply(ctx, config) {
  if (config.enabled === false) return
  const linked = config.linkMemory === false ? () => [] : () => linkedMemoryFiles(dshHomePath(), config.linkedPaths ?? [])
  const home = config.home || dshHomePath('heart')
  const store = new HeartStore(home, linked)
  const people = new PeopleStore(home)
  const agents = ctx.get('agents')
  const installs = new Map()      // agent → {fiber, key, mode}
  const reminded = new WeakMap()  // agent → 已提醒过的 surface.replaceGeneration
  const states = new Map()        // agent.id → 此刻对面是谁
  const tools = ctx.get('tools')
  const configured = () => config.ta ?? []
  const taKeys = () => people.taKeys(configured())
  const optsOf = (agent) => ({ im: installs.get(agent)?.mode?.im ?? false, untagged: config.untagged ?? 'auto', taKeys: taKeys() })

  // 还没收到过消息的会话（刚启动、闹钟叫醒）：先看上次认出的结果，没有就按"什么都没带"算
  const stateOf = (agent) => {
    if (!agent) return undefined
    let s = states.get(agent.id)
    if (s === undefined) {
      s = people.sessionState(agent.id) ?? classify(undefined, agent.id, optsOf(agent))
      states.set(agent.id, s)
    }
    return s
  }
  const gate = heartGate(stateOf)

  const modeOf = (agent) => {
    let names = []
    try {
      names = tools.schemas(agent).map((t) => t.name)
    } catch {
      // 看不到工具表就按什么都没装处理
    }
    return detect(names, config)
  }

  const install = (agent) => {
    if (isSubagent(agent)) return undefined
    const mode = modeOf(agent)
    const biliIds = [...taKeys()].filter((k) => k.startsWith('bili:')).map((k) => k.slice(5))
    const key = `${mode.memory}/${mode.proactive}/${mode.fork}/${mode.others.join(',')}/${mode.im}/${mode.bili}/${biliIds.join(',')}`
    const current = installs.get(agent)
    if (current?.key === key) return current.fiber
    if (current) remove(agent)
    const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (c) => {
      c.systemPrompt.section({ name: 'dsh-heart:charter', order: CHARTER_ORDER, text: CHARTER, interpolate: false })
      c.systemPrompt.section({ name: 'dsh-heart:identity', order: IDENTITY_ORDER, text: identityText(config), interpolate: false })
      const abilities = abilitiesText(mode, { biliIds })
      if (abilities) c.systemPrompt.section({ name: 'dsh-heart:abilities', order: ABILITIES_ORDER, text: abilities, interpolate: false })
      c.systemPrompt.context({
        name: 'dsh-heart:self',
        order: SELF_ORDER,
        interpolate: false,
        text: () => {
          const s = stateOf(agent)
          try {
            return store.selfText(s.who === 'ta' && !s.group)
          } catch (error) {
            ctx.logger?.warn?.(`dsh-heart: 读自述失败：${String(error)}`)
            return ''
          }
        },
      })
      c.systemPrompt.context({ name: 'dsh-heart:who', order: WHO_ORDER, interpolate: false, required: true, text: () => whoText(stateOf(agent)) })
      c.tools.register(selfTool(store, stateOf))
      c.tools.register(peopleTool(people, { stateOf, configured, onChange: refresh }))
      if (mode.memory !== 'heart') return
      c.systemPrompt.context({
        name: 'dsh-heart:digest',
        order: DIGEST_ORDER,
        interpolate: false,
        text: () => {
          const s = stateOf(agent)
          if (s.who !== 'ta' || s.group) return ''
          try {
            return store.digest(config.digestChars, config.recentSummaries)
          } catch (error) {
            ctx.logger?.warn?.(`dsh-heart: 读心事本失败：${String(error)}`)
            return ''
          }
        },
      })
      for (const tool of heartTools(store, gate)) c.tools.register(tool)
    })
    installs.set(agent, { fiber, key, mode })
    return fiber
  }

  const remove = (agent) => {
    const current = installs.get(agent)
    if (current === undefined) return
    installs.delete(agent)
    current.fiber.dispose?.()?.catch?.((error) => ctx.logger?.warn?.(`dsh-heart: 卸载失败：${String(error)}`))
  }

  // 自己注册 heart_* 也会触发 tools/change；detect 不计 heart_*，结果不变就不重装，不会来回抖
  const reconcile = () => {
    for (const agent of agents.list()) if (!isSubagent(agent)) install(agent)
  }

  // 认领、取消之后：已经在聊的会话立刻按新名单重认，能力说明里的 B 站 uid 跟着换
  function refresh() {
    const keys = taKeys()
    for (const [id, s] of states) {
      if (!s.key || s.group) continue
      const who = keys.has(s.key) || keys.has(`session:${id}`) ? 'ta' : (s.who === 'ta' && !s.local ? 'unsure' : s.who)
      if (who !== s.who) {
        const next = { ...s, who }
        states.set(id, next)
        people.saveSession(id, next)
      }
    }
    reconcile()
  }

  ctx.on('agent/created', async ({ agent }) => {
    await install(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    remove(agent)
    states.delete(agent?.id)
  })

  // 每条真正的用户消息（不是闹钟、提醒、插件注入的）在组装提示词之前判定一次
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (!installs.has(agent) || message?.source?.kind === undefined) return
    const src = message.source
    if (src.kind !== 'user' && !src.sender && src.peerId === undefined) return
    const prev = stateOf(agent)
    const text = textOf(message)
    let next = classify(src, agent.id, { ...optsOf(agent), text })
    // 带着本机配对码来的：认下这个账号（会话 id 里看不出是谁时，就认下这个会话）。群里发的不算，码也不作废
    if (next.who !== 'ta' && !next.group && !prev.group && people.takePairCode(text)) {
      const key = next.key && !next.key.startsWith('chat:') ? next.key : `session:${agent.id}`
      try {
        people.bind(key, '配对码认领')
        next = { ...next, who: 'ta', key, paired: true }
      } catch (error) {
        ctx.logger?.warn?.(`dsh-heart: 配对没认下：${String(error)}`)
      }
    }
    const keys = new Set(prev.keys ?? [])
    if (next.key && !next.local) keys.add(next.key)
    const tas = taKeys()
    // 一个会话里出现过群、或者不止一个人，就一直按群聊算
    next.group = Boolean(next.group || keys.size > 1 || [...keys].some(isGroupKey))
    // ta 在本机界面里插进一段连着聊天通道的对话：说话的是 ta，可回复会发给通道那头的人
    if (next.local && [...keys].some((k) => !tas.has(k))) {
      next.watched = true
      next.group = true
    }
    next.keys = [...keys].slice(-50)
    next.taHere = next.group && [...keys].some((k) => tas.has(k))
    states.set(agent.id, next)
    people.saveSession(agent.id, next)
    try {
      people.noteVisit(next, agent.id, textOf(message))
    } catch {
      // 记不下来访不影响认人
    }
  })
  ctx.on('tools/change', reconcile)
  reconcile()

  if (config.reminderRatio > 0) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      const { agent, signal } = payload
      if (decision.kind !== 'enter' || !installs.has(agent) || signal?.aborted) return decision
      const s = stateOf(agent)
      if (s.who !== 'ta' || s.group) return decision
      const generation = agent.session.surface?.replaceGeneration ?? 0
      if (reminded.get(agent) === generation) return decision
      try {
        if (!(await overReminderLine(ctx, agent, config.reminderRatio, signal))) return decision
      } catch {
        return decision
      }
      reminded.set(agent, generation)
      const message = createUserMessage({
        content: [{ type: 'text', text: COMPACTION_REMINDER }],
        source: heartSource('提醒记下想留下的东西'),
      })
      return { ...decision, messages: [...decision.messages, message] }
    })
  }
}
