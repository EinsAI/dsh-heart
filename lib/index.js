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
import { CHARTER, COMPACTION_REMINDER, identityText } from './charter.js'
import { abilitiesText, detect } from './abilities.js'
import { HeartStore, linkedMemoryFiles } from './store.js'

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
})

// 放在 persona（0）之后、各插件和工具段落（117 起）之前
export const CHARTER_ORDER = 20
// 动态上下文：排在 dsh 自己的运行时上下文（100–210）之后
export const DIGEST_ORDER = 300
export const IDENTITY_ORDER = CHARTER_ORDER + 1
export const ABILITIES_ORDER = CHARTER_ORDER + 2

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

function refuseSubagent(exec) {
  if (exec.agent === undefined || isSubagent(exec.agent)) {
    throw new Error('dsh-heart 的工具只属于主智能体')
  }
  return exec.agent.id
}

export function heartTools(store) {
  const note = defineTool({
    name: 'heart_note',
    description: '在心事本里随手记一笔：ta 的心情和状态、我的感受、ta 在意的事、我们说好的事。这是心里的想法，不用说出口。',
    parameters: { text: { type: 'string', required: true, description: '要记的内容，第一人称。' } },
    output: { schema: OK, render: (_a, v) => [{ type: 'text', text: `记下了（随手记#${v.id}）` }] },
    async execute(args, exec) {
      const session = refuseSubagent(exec)
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
      const session = refuseSubagent(exec)
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
      const session = refuseSubagent(exec)
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
      refuseSubagent(exec)
      const items = store.recall(args.query, args.limit ?? 8)
      const text = items.length === 0
        ? '心事本里没找到相关的。'
        : items.map((it) => `- ${it.kind}#${it.id}${it.at ? `（${String(it.at).slice(0, 16).replace('T', ' ')}）` : ''}：${it.text}`).join('\n')
      return { count: items.length, text }
    },
  })

  return [note, summary, longterm, recall]
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
  const store = new HeartStore(config.home || dshHomePath('heart'), linked)
  const agents = ctx.get('agents')
  const installs = new Map()      // agent → {fiber, mode}
  const reminded = new WeakMap()  // agent → 已提醒过的 surface.replaceGeneration
  const tools = ctx.get('tools')

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
    const key = `${mode.memory}/${mode.proactive}/${mode.fork}/${mode.others.join(',')}`
    const current = installs.get(agent)
    if (current?.key === key) return current.fiber
    if (current) remove(agent)
    const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (c) => {
      c.systemPrompt.section({ name: 'dsh-heart:charter', order: CHARTER_ORDER, text: CHARTER, interpolate: false })
      c.systemPrompt.section({ name: 'dsh-heart:identity', order: IDENTITY_ORDER, text: identityText(config), interpolate: false })
      const abilities = abilitiesText(mode)
      if (abilities) c.systemPrompt.section({ name: 'dsh-heart:abilities', order: ABILITIES_ORDER, text: abilities, interpolate: false })
      if (mode.memory !== 'heart') return
      c.systemPrompt.context({
        name: 'dsh-heart:digest',
        order: DIGEST_ORDER,
        interpolate: false,
        text: () => {
          try {
            return store.digest(config.digestChars, config.recentSummaries)
          } catch (error) {
            ctx.logger?.warn?.(`dsh-heart: 读心事本失败：${String(error)}`)
            return ''
          }
        },
      })
      for (const tool of heartTools(store)) c.tools.register(tool)
    })
    installs.set(agent, { fiber, key })
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

  ctx.on('agent/created', async ({ agent }) => {
    await install(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => remove(agent))
  ctx.on('tools/change', reconcile)
  reconcile()

  if (config.reminderRatio > 0) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      const { agent, signal } = payload
      if (decision.kind !== 'enter' || !installs.has(agent) || signal?.aborted) return decision
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
