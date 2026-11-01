import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HeartStore } from '../lib/store.js'
import { Rhythm, clock, timeZoneOf } from '../lib/clock.js'
import { apply } from '../lib/index.js'

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
  const services = {
    agents: { list: () => agents },
    tools: { schemas: (agent) => [...otherTools, ...(agent?.registered?.tools ?? []).map((t) => t.name)].map((name) => ({ name })) },
  }
  return {
    listeners,
    get: (name) => services[name],
    on: (name, fn) => { (listeners[name] ??= []).push(fn) },
    logger: { warn() {} },
  }
}

const base = { enabled: true, memory: 'heart', proactive: 'auto', digestChars: 6000, recentSummaries: 3, reminderRatio: 0, linkMemory: false, linkedPaths: [], ta: [], untagged: 'auto', timeZone: 'Asia/Shanghai', reviewHours: 20 }
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-rhythm-'))
const msg = (source, text = '你好') => ({ role: 'user', content: [{ type: 'text', text }], source })
const tool = (agent, name) => agent.registered.tools.find((t) => t.name === name)
const ctxText = (agent, name) => agent.registered.contexts.find((c) => c.name === name)?.text()
const ability = (agent) => agent.registered.sections.find((s) => s.name === 'dsh-heart:abilities').text

async function preStep(host, agent, messages) {
  let out
  for (const fn of host.listeners['agent/pre-step'] ?? []) {
    out = await fn({ agent, messages, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [...messages] }))
  }
  return out
}

test('约定本：只追加；到期写日期；摘要列出还算数的，过期和今天的标出来', () => {
  const s = new HeartStore(home())
  const a = s.addPromise('me', '给 ta 讲完那部番的结局', '2026-10-30', 'x')
  const b = s.addPromise('joke', '「鱼塘主」是 ta 的外号', undefined, 'x')
  const c = s.addPromise('ta', 'ta 说周日陪我看电影', '2026-10-31 20:00', 'x')
  assert.throws(() => s.addPromise('me', '明天去', '明天', 'x'), /2026-11-01/)
  assert.throws(() => s.addPromise('weird', 'x', undefined, 'x'), /type/)
  s.updatePromise(b.id, 'note', 'ta 自己也这么叫了', 'x')
  const d = s.digest(6000, 3, '2026-10-31')
  assert.match(d, new RegExp(`约定#${a.id}［我答应的］给 ta 讲完那部番的结局（到期 2026-10-30，已经过了）`))
  assert.match(d, new RegExp(`约定#${c.id}.*就是今天`))
  assert.match(d, /后来：ta 自己也这么叫了/)
  s.updatePromise(a.id, 'done', '讲完了，ta 说结局太刀', 'x')
  assert.doesNotMatch(s.digest(6000, 3, '2026-10-31'), /讲完那部番/)
  // 原来那条和补的一笔都还在
  const raw = s.readJsonl('promises.jsonl')
  assert.equal(raw.length, 5)
  assert.equal(raw[0].text, '给 ta 讲完那部番的结局')
  assert.match(s.recall('番 结局').map((r) => r.text).join('\n'), /做到了：讲完了/)
  assert.throws(() => s.updatePromise(99, 'done', '', 'x'), /99/)
})

test('提起的分寸：四档；改了新写一条替换旧的，旧的反应跟着走；只追加', () => {
  const s = new HeartStore(home())
  const r1 = s.addTact('ta 前女友', 'wait', 'ta 上次提起时很低落', 'x')
  s.addTactNote(r1.id, 'ta 主动问起，说现在已经放下了', 'x')
  const r2 = s.addTact('ta 前女友', 'light', 'ta 说已经放下了', 'x', r1.id)
  const now = s.tacts()
  assert.equal(now.length, 1)
  assert.equal(now[0].id, r2.id)
  assert.equal(now[0].notes[0].text, 'ta 主动问起，说现在已经放下了')
  const d = s.digest()
  assert.match(d, new RegExp(`分寸#${r2.id} ta 前女友：轻轻带过；上次提起时：ta 主动问起`))
  assert.doesNotMatch(d, /等 ta 问起/)
  assert.equal(s.readJsonl('tact.jsonl').length, 3)
  assert.throws(() => s.addTact('x', 'forget', '', 'x'), /level/)
  assert.throws(() => s.addTact('x', 'open', '', 'x', 42), /42/)
})

test('复盘：look 只看上次复盘以来的；done 之后清零', () => {
  const s = new HeartStore(home())
  s.addNote('ta 今天加班到十点', 'x')
  s.addPromise('habit', '晚上十一点提醒 ta 睡觉', undefined, 'x')
  assert.ok(s.oldestUnreviewed())
  const first = s.sinceReview()
  assert.equal(first.since, undefined)
  assert.equal(first.notes.length, 1)
  assert.equal(first.promises.length, 1)
  s.addReview('把加班的事并进长期笔记', 'x')
  assert.equal(s.oldestUnreviewed(), undefined)
  assert.equal(s.sinceReview().notes.length, 0)
})

test('时钟：按配置的时区；作息只记钟点，至少两天才算常在', () => {
  assert.equal(timeZoneOf({ timeZone: 'Asia/Shanghai' }), 'Asia/Shanghai')
  assert.notEqual(timeZoneOf({ timeZone: 'Mars/Olympus' }), 'Mars/Olympus')
  const c = clock('Asia/Shanghai', new Date('2026-10-31T15:30:00Z'))
  assert.equal(c.date, '2026-10-31')
  assert.equal(c.hour, 23)
  assert.equal(c.text, '2026-10-31 周六 23 点')
  assert.equal(clock('Asia/Shanghai', new Date('2026-10-31T16:30:00Z')).date, '2026-11-01')
  const r = new Rhythm(home())
  r.note({ date: '2026-10-30', hour: 22 })
  assert.equal(r.summary('2026-10-30'), '')
  r.note({ date: '2026-10-31', hour: 22 })
  r.note({ date: '2026-10-31', hour: 23 })
  r.note({ date: '2026-10-31', hour: 9 })
  assert.match(r.summary('2026-10-31'), /^22–23 点/)
  assert.doesNotMatch(r.summary('2026-10-31'), /9–10/)
  // 文件里只有日期和 24 格计数
  const raw = JSON.parse(fs.readFileSync(path.join(r.dir, 'rhythm.json'), 'utf8'))
  assert.deepEqual(Object.keys(raw.days), ['2026-10-30', '2026-10-31'])
  assert.equal(raw.days['2026-10-31'].length, 24)
})

test('现在几点放在眼前；ta 常在的钟点只在有闹钟、和 ta 单独说话时给', async () => {
  const dir = home()
  const r = new Rhythm(dir)
  const today = clock('Asia/Shanghai').date
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
  for (const d of [yesterday, today]) r.note({ date: d, hour: 21 })

  const withAlarm = fakeAgent('a')
  apply(fakeHost([withAlarm], ['schedule_create']), { ...base, home: dir })
  const t = ctxText(withAlarm, 'dsh-heart:now')
  assert.match(t, new RegExp(`${today} 周. \\d+ 点（Asia/Shanghai）`))
  assert.match(t, /ta 常在的钟点：21–22 点/)

  const noAlarm = fakeAgent('b')
  apply(fakeHost([noAlarm]), { ...base, home: dir })
  assert.doesNotMatch(ctxText(noAlarm, 'dsh-heart:now'), /常在/)

  const guest = fakeAgent('im:qq:private:1:G')
  const gh = fakeHost([guest], ['schedule_create', 'qqbot_send_file'])
  apply(gh, { ...base, home: dir })
  for (const fn of gh.listeners['agent/inbox/claimed']) fn({ agent: guest, message: msg({ kind: 'user' }), turn: 1 })
  assert.match(ctxText(guest, 'dsh-heart:now'), /现在/)
  assert.doesNotMatch(ctxText(guest, 'dsh-heart:now'), /常在/)
})

test('ta 来说话时记下钟点；客人、闹钟不记', async () => {
  const dir = home()
  const me = fakeAgent('me')
  const guest = fakeAgent('im:qq:private:1:G')
  const host = fakeHost([me, guest], ['qqbot_send_file'])
  apply(host, { ...base, home: dir })
  const claim = (agent, source) => { for (const fn of host.listeners['agent/inbox/claimed']) fn({ agent, message: msg(source), turn: 1 }) }
  claim(me, { kind: 'user', rpcId: 'r' })
  claim(guest, { kind: 'user' })
  claim(me, { kind: 'schedule' })
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'rhythm.json'), 'utf8'))
  const counts = Object.values(raw.days).flat()
  assert.equal(counts.reduce((a, b) => a + b, 0), 1)
})

test('能力说明：有 schedule 时让她定每天的复盘闹钟；有 proactive 用 proactive_set；没有闹钟靠插件提醒', () => {
  const a = fakeAgent('a')
  apply(fakeHost([a], ['schedule_create']), { ...base, home: home() })
  assert.match(ability(a), /schedule_create 的 daily/)
  assert.match(ability(a), /heart_review/)
  assert.match(ability(a), /写日期/)
  const b = fakeAgent('b')
  apply(fakeHost([b], ['proactive_set']), { ...base, home: home() })
  assert.match(ability(b), /proactive_set 给自己定一个复盘闹钟/)
  const c = fakeAgent('c')
  apply(fakeHost([c]), { ...base, home: home() })
  assert.match(ability(c), /插件会在 ta 下次来找我时提醒我一次/)
  // 借用别的记忆插件时没有心事本，也就不写复盘
  const d = fakeAgent('d')
  apply(fakeHost([d], ['memory_save']), { ...base, memory: 'auto', home: home() })
  assert.doesNotMatch(ability(d), /# 复盘/)
})

test('复盘提醒：攒了没整理的、又过了 reviewHours，ta 来说话的那一步提醒一次', async () => {
  const dir = home()
  const store = new HeartStore(dir)
  const old = new Date(Date.now() - 30 * 3600000).toISOString()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'notes.jsonl'), JSON.stringify({ id: 1, at: old, session: 'x', text: 'ta 在赶 deadline' }) + '\n')
  const me = fakeAgent('me')
  const host = fakeHost([me])
  apply(host, { ...base, home: dir })
  const user = [msg({ kind: 'user', rpcId: 'r' })]
  const reminders = (d) => d.messages.filter((m) => m.source?.kind === 'dsh-heart' || m.source?.plugin === 'dsh-heart')

  // 闹钟叫醒的那一步不提醒（闹钟自己就是来叫她复盘的）
  assert.equal(reminders(await preStep(host, me, [msg({ kind: 'schedule' }, '复盘')])).length, 0)
  const d1 = await preStep(host, me, user)
  assert.equal(reminders(d1).length, 1)
  assert.match(reminders(d1)[0].content[0].text, /过了 20 个多小时/)
  // 同一段没复盘的只提醒一次
  assert.equal(reminders(await preStep(host, me, user)).length, 0)
  // 复盘了就不再提醒；之后又攒了，但还没过 20 小时，也不提醒
  await tool(me, 'heart_review').execute({ action: 'done', text: '整理了 deadline 的事' }, { agent: me })
  store.addNote('新的一笔', 'x')
  assert.equal(reminders(await preStep(host, me, user)).length, 0)
})

test('复盘提醒：没东西可整理、客人那边、reviewHours=0 都不提醒', async () => {
  const empty = fakeAgent('e')
  const h1 = fakeHost([empty])
  apply(h1, { ...base, home: home() })
  assert.equal((await preStep(h1, empty, [msg({ kind: 'user', rpcId: 'r' })])).messages.length, 1)

  const dir = home()
  const old = new Date(Date.now() - 30 * 3600000).toISOString()
  fs.writeFileSync(path.join(dir, 'notes.jsonl'), JSON.stringify({ id: 1, at: old, session: 'x', text: 'x' }) + '\n')
  const guest = fakeAgent('im:qq:private:1:G')
  const h2 = fakeHost([guest], ['qqbot_send_file'])
  apply(h2, { ...base, home: dir })
  for (const fn of h2.listeners['agent/inbox/claimed']) fn({ agent: guest, message: msg({ kind: 'user' }), turn: 1 })
  assert.equal((await preStep(h2, guest, [msg({ kind: 'user' })])).messages.length, 1)

  const me = fakeAgent('m')
  const h3 = fakeHost([me])
  apply(h3, { ...base, home: dir, reviewHours: 0 })
  assert.equal(h3.listeners['agent/pre-step'], undefined)
})

test('工具把关：look、分寸、改约定只在和 ta 单独说话时；群里能往约定本里记 ta 答应的', async () => {
  const dir = home()
  const group = fakeAgent('g')
  const host = fakeHost([group], ['qqbot_send_file'])
  apply(host, { ...base, home: dir, ta: ['qq:TA1'] })
  for (const fn of host.listeners['agent/inbox/claimed']) fn({ agent: group, message: msg({ kind: 'user', sender: { channel: 'qq', id: 'TA1', group: 'G1' } }), turn: 1 })
  const p = await tool(group, 'heart_promise').execute({ action: 'add', type: 'ta', text: 'ta 在群里答应 11-02 一起开黑', due: '2026-11-02' }, { agent: group })
  assert.equal(p.id, 1)
  await assert.rejects(tool(group, 'heart_promise').execute({ action: 'update', of: 1, status: 'done' }, { agent: group }), /群聊/)
  await assert.rejects(tool(group, 'heart_review').execute({ action: 'look' }, { agent: group }), /群聊/)
  await assert.rejects(tool(group, 'heart_tact').execute({ action: 'set', topic: 'x', level: 'open' }, { agent: group }), /群聊/)
  assert.equal(ctxText(group, 'dsh-heart:digest'), '')

  const me = fakeAgent('me')
  const h2 = fakeHost([me])
  apply(h2, { ...base, home: dir })
  const look = await tool(me, 'heart_review').execute({ action: 'look' }, { agent: me })
  assert.match(look.text, /还没复盘过/)
  assert.match(look.text, /约定#1［ta 答应的］ta 在群里答应 11-02 一起开黑/)
})
