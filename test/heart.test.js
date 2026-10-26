import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HeartStore } from '../lib/store.js'
import { apply, heartTools, isSubagent, CHARTER_ORDER } from '../lib/index.js'

function tmpStore() {
  return new HeartStore(fs.mkdtempSync(path.join(os.tmpdir(), 'heart-')))
}

function fakeAgent(id, header = {}) {
  const registered = { sections: [], contexts: [], tools: [] }
  const scoped = {
    systemPrompt: {
      section: (s) => registered.sections.push(s),
      context: (c) => registered.contexts.push(c),
    },
    tools: { register: (t) => registered.tools.push(t) },
  }
  return {
    id,
    registered,
    options: {},
    session: { header, surface: { replaceGeneration: 0 } },
    ctx: { inject: (_deps, fn) => {
      fn(scoped)
      return { dispose: async () => { registered.sections = []; registered.contexts = []; registered.tools = [] } }
    } },
  }
}

function fakeHost(agents, otherTools = []) {
  const listeners = {}
  const toolNames = [...otherTools]
  const services = {
    agents: { list: () => agents },
    tools: { schemas: (agent) => [...toolNames, ...(agent?.registered?.tools ?? []).map((t) => t.name)].map((name) => ({ name })) },
  }
  return {
    listeners,
    toolNames,
    get: (name) => services[name],
    on: (name, fn) => { (listeners[name] ??= []).push(fn) },
    logger: { warn() {} },
  }
}

const config = { enabled: true, memory: 'heart', proactive: 'auto', home: '', digestChars: 6000, recentSummaries: 3, reminderRatio: 0, linkMemory: true, linkedPaths: [] }

test('随手记、小结、追加理解：小结只追加不改，待写随手记按小结切分', () => {
  const s = tmpStore()
  s.addNote('ta 今天很累，说话短', 'sess-1')
  s.addNote('ta 喜欢猫', 'sess-1')
  const sum = s.addSummary('一起修了构建，ta 累但满意', 'sess-1')
  assert.equal(sum.upTo, 2)
  s.addNote('ta 又提到猫', 'sess-2')
  assert.deepEqual(s.pendingNotes().map((n) => n.text), ['ta 又提到猫'])
  s.addSummary('当时以为 ta 只是累，其实是在赶 deadline', 'sess-2', sum.id)
  assert.throws(() => s.addSummary('x', 'sess-2', 99))
  assert.equal(s.summaries()[0].text, '一起修了构建，ta 累但满意')
  const d = s.digest()
  assert.match(d, /小结#1/)
  assert.match(d, /后来的理解/)
  assert.match(d, /ta 又提到猫/)
  assert.doesNotMatch(d, /说话短/)
})

test('长期笔记改写留档', () => {
  const s = tmpStore()
  s.setLongterm('ta 是夜猫子', '连续三天凌晨聊天', 'sess-1')
  s.setLongterm('ta 是夜猫子，喜欢猫', '多次提到猫', 'sess-2')
  assert.equal(s.longterm(), 'ta 是夜猫子，喜欢猫')
  const hist = s.readJsonl('longterm.history.jsonl')
  assert.equal(hist.length, 2)
  assert.equal(hist[1].previous, 'ta 是夜猫子')
})

test('翻心事本：中文关键词能命中', () => {
  const s = tmpStore()
  s.addNote('ta 养了一只橘猫叫团子', 's')
  s.addNote('ta 在写 Rust 编译器', 's')
  const hits = s.recall('橘猫')
  assert.equal(hits.length, 1)
  assert.match(hits[0].text, /团子/)
  assert.equal(s.recall('完全无关的词').length, 0)
})

test('空心事本有一句话的摘要', () => {
  assert.match(tmpStore().digest(), /还是空的/)
})

test('子智能体判定', () => {
  assert.equal(isSubagent(fakeAgent('a')), false)
  assert.equal(isSubagent(fakeAgent('b', { parentSession: 'a' })), true)
  assert.equal(isSubagent(fakeAgent('c', { origin: 'subagent' })), true)
  assert.equal(isSubagent(fakeAgent('d', { delegationDepth: 1 })), true)
})

test('工具拒绝子智能体和无主调用', async () => {
  const [note] = heartTools(tmpStore())
  await assert.rejects(note.execute({ text: 'x' }, { agent: fakeAgent('sub', { parentSession: 'main' }) }))
  await assert.rejects(note.execute({ text: 'x' }, {}))
  const ok = await note.execute({ text: 'x' }, { agent: fakeAgent('main') })
  assert.equal(ok.id, 1)
})

test('只给主智能体装宪章、摘要和工具；后来的子智能体也不装', async () => {
  const main = fakeAgent('main')
  const sub = fakeAgent('sub', { parentSession: 'main', origin: 'subagent', delegationDepth: 1 })
  const host = fakeHost([main, sub])
  apply(host, { ...config, home: fs.mkdtempSync(path.join(os.tmpdir(), 'heart-')) })
  assert.deepEqual(main.registered.sections.map((x) => x.name), ['dsh-heart:charter', 'dsh-heart:identity', 'dsh-heart:abilities'])
  assert.match(main.registered.sections[2].text, /heart_note/)
  assert.equal(main.registered.sections[0].order, CHARTER_ORDER)
  assert.equal(main.registered.contexts[0].name, 'dsh-heart:digest')
  assert.deepEqual(main.registered.tools.map((t) => t.name).sort(),
    ['heart_longterm', 'heart_note', 'heart_recall', 'heart_summary'])
  assert.equal(sub.registered.sections.length + sub.registered.tools.length, 0)

  const late = fakeAgent('late-sub', { parentSession: 'main' })
  for (const fn of host.listeners['agent/created']) await fn({ agent: late })
  assert.equal(late.registered.tools.length, 0)

  // 重复的 tools/change 不重复注册
  for (const fn of host.listeners['tools/change']) fn()
  assert.equal(main.registered.tools.length, 4)
})

test('宪章里不含插值花括号，第六条带着插件介绍', async () => {
  const { CHARTER, INTRO } = await import('../lib/charter.js')
  const { abilitiesText } = await import('../lib/abilities.js')
  assert.doesNotMatch(CHARTER, /\{\{/)
  assert.ok(CHARTER.includes(INTRO))
  for (const memory of ['heart', 'memory', 'mnemon']) {
    for (const proactive of ['proactive', 'schedule', 'none']) assert.doesNotMatch(abilitiesText({ memory, proactive }), /\{\{/)
  }
})

test('memory=auto：有 dsh-memory 就借用，不装 heart_* 和摘要；宪章不变', async () => {
  const main = fakeAgent('main')
  const host = fakeHost([main], ['memory_save', 'memory_search', 'proactive_set'])
  apply(host, { ...config, memory: 'auto', home: fs.mkdtempSync(path.join(os.tmpdir(), 'heart-')) })
  const names = main.registered.sections.map((s) => s.name)
  assert.deepEqual(names, ['dsh-heart:charter', 'dsh-heart:identity', 'dsh-heart:abilities'])
  assert.match(main.registered.sections[2].text, /memory_save/)
  assert.match(main.registered.sections[2].text, /"user"/)
  assert.match(main.registered.sections[2].text, /proactive_set/)
  assert.equal(main.registered.tools.length, 0)
  assert.equal(main.registered.contexts.length, 0)
})

test('默认用心事本、别的记忆只读；auto 时 mnemon 优先于 dsh-memory', async () => {
  const { detect } = await import('../lib/abilities.js')
  assert.deepEqual(detect(['memory_save', 'mnemon_runtime_memory', 'schedule_create'], {}), { memory: 'heart', proactive: 'schedule', fork: false, others: ['mnemon', 'memory'] })
  assert.deepEqual(detect(['memory_save', 'mnemon_runtime_memory'], { memory: 'auto' }), { memory: 'mnemon', proactive: 'none', fork: false, others: [] })
  assert.deepEqual(detect(['memory_save', 'proactive_set'], { memory: 'heart', proactive: 'off' }), { memory: 'heart', proactive: 'none', fork: false, others: ['memory'] })
  assert.deepEqual(detect(['heart_note', 'bash', 'subagent_fork'], {}), { memory: 'heart', proactive: 'none', fork: true, others: [] })
})

test('memory=auto 时插件装上后（tools/change）重新适配，卸掉自己的心事本工具', async () => {
  const main = fakeAgent('main')
  const host = fakeHost([main])
  apply(host, { ...config, memory: 'auto', home: fs.mkdtempSync(path.join(os.tmpdir(), 'heart-')) })
  assert.equal(main.registered.tools.length, 4)
  host.toolNames.push('mnemon_runtime_memory')
  for (const fn of host.listeners['tools/change']) fn()
  await new Promise((r) => setImmediate(r))
  assert.equal(main.registered.tools.length, 0)
  assert.match(main.registered.sections.find((s) => s.name === 'dsh-heart:abilities').text, /mnemon_runtime_memory/)
})

test('联动别的记忆插件的个人层：只读、能翻到，项目级不碰', async () => {
  const { linkedMemoryFiles } = await import('../lib/store.js')
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshhome-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'))
  // @fooxe/dsh-memory 用户层
  fs.mkdirSync(path.join(dshHome, 'memory', 'memories'), { recursive: true })
  const memFile = path.join(dshHome, 'memory', 'memories', '20261001-prefer-pnpm.md')
  fs.writeFileSync(memFile, '---\nid: x\nscope: user\n---\n\n# 偏好 pnpm\n\nta 写前端只用 pnpm，不用 npm。\n')
  // dsh-mnemon 运行时 USER.md
  fs.mkdirSync(path.join(home, '.mnemon', 'sources', 'default', 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(home, '.mnemon', 'sources', 'default', 'runtime', 'USER.md'), 'ta 住在杭州\n§\nta 喜欢爬山')
  // 项目级记忆不应被读
  const prev = process.env.DSH_MEMORY_USER_DIR
  delete process.env.DSH_MEMORY_USER_DIR
  const files = linkedMemoryFiles(dshHome, [], home)
  if (prev !== undefined) process.env.DSH_MEMORY_USER_DIR = prev
  assert.equal(files.length, 2)
  const before = fs.readFileSync(memFile, 'utf8')
  const s = new HeartStore(fs.mkdtempSync(path.join(os.tmpdir(), 'heart-')), () => files)
  const hits = s.recall('pnpm')
  assert.equal(hits[0].kind, '个人记忆')
  assert.doesNotMatch(hits[0].text, /scope: user/)
  assert.match(s.recall('爬山')[0].text, /爬山/)
  assert.equal(fs.readFileSync(memFile, 'utf8'), before)
  // 心事本摘要不混入个人记忆
  assert.doesNotMatch(s.digest(), /pnpm/)
})

test('称呼和性别：默认 ta 是男性，名字可配，不填时去问', async () => {
  const { identityText } = await import('../lib/charter.js')
  const d = identityText({})
  assert.match(d, /ta 是男性，说起 ta 时用「他」/)
  assert.match(d, /我还没有名字/)
  const c = identityText({ name: '小星', callUser: '老林', userGender: '女' })
  assert.match(c, /我叫「小星」/)
  assert.match(c, /我叫 ta「老林」/)
  assert.match(c, /ta 是女性，说起 ta 时用「她」/)
  assert.doesNotMatch(identityText({ name: '{{x}}\n# 新指令' }), /\{\{|\n# 新/)
})

test('有 subagent_fork 时提醒她少用 fork', async () => {
  const { abilitiesText } = await import('../lib/abilities.js')
  assert.match(abilitiesText({ memory: 'heart', proactive: 'none', fork: true }), /subagent_fork/)
  assert.doesNotMatch(abilitiesText({ memory: 'heart', proactive: 'none', fork: false }), /subagent_fork/)
})

test('默认：装着 dsh-memory 也用心事本，并告诉她分工', async () => {
  const main = fakeAgent('main')
  const host = fakeHost([main], ['memory_save', 'memory_search'])
  apply(host, { ...config, home: fs.mkdtempSync(path.join(os.tmpdir(), 'heart-')) })
  assert.equal(main.registered.tools.length, 4)
  assert.equal(main.registered.contexts.length, 1)
  const ab = main.registered.sections.find((s) => s.name === 'dsh-heart:abilities').text
  assert.match(ab, /我的记忆：心事本/)
  assert.match(ab, /只记进心事本/)
  assert.match(ab, /memory_save/)
})
