import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classify, looksLikeGroupText, senderOf, sessionHint, PeopleStore } from '../lib/people.js'
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

const base = { enabled: true, memory: 'heart', proactive: 'auto', digestChars: 6000, recentSummaries: 3, reminderRatio: 0, linkMemory: false, linkedPaths: [], ta: [], untagged: 'auto' }

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-people-'))
const msg = (source, text = '你好') => ({ role: 'user', content: [{ type: 'text', text }], source })
const claim = (host, agent, message) => { for (const fn of host.listeners['agent/inbox/claimed']) fn({ agent, message, turn: 1 }) }
const ctxText = (agent, name) => agent.registered.contexts.find((c) => c.name === name).text()
const tool = (agent, name) => agent.registered.tools.find((t) => t.name === name)

test('认人只看硬信号：约定的 sender、dsh-weixin 的 peerId、远程访问的 principal、会话 id', () => {
  const ta = new Set(['qq:TA1', 'weixin:wxTA'])
  assert.equal(classify({ kind: 'user', sender: { channel: 'qq', id: 'TA1', name: '小林' } }, 's', { im: true, taKeys: ta }).who, 'ta')
  assert.equal(classify({ kind: 'user', sender: { channel: 'qq', id: 'X9' } }, 's', { im: true, taKeys: ta }).who, 'guest')
  assert.equal(classify({ kind: 'weixin', accountId: 'a', peerId: 'wxTA' }, 's', { taKeys: ta }).who, 'ta')
  assert.equal(classify({ kind: 'user', rpcId: 'r', principal: { kind: 'share', id: 'p1' } }, 's', { taKeys: ta }).who, 'guest')
  // dsh 自己的界面（主人）
  assert.deepEqual(classify({ kind: 'user', rpcId: 'r' }, 's', { im: true, taKeys: ta }), { who: 'ta', local: true })
  // 什么都没带：没装聊天通道就是本机的主人，装了就认不出
  assert.equal(classify({ kind: 'user' }, 's', { im: false, taKeys: ta }).who, 'ta')
  assert.equal(classify({ kind: 'user' }, 's', { im: true, taKeys: ta }).who, 'unsure')
  assert.equal(classify({ kind: 'user' }, 's', { im: true, untagged: 'ta', taKeys: ta }).who, 'ta')
  // 主人认领过的会话
  assert.equal(classify({ kind: 'user' }, 'abc', { im: true, taKeys: new Set(['session:abc']) }).who, 'ta')
  // 自称不算：正文里说"我是 ta"、昵称和 ta 一样都没用
  assert.equal(classify({ kind: 'user', sender: { channel: 'qq', id: 'X9', name: '小林' } }, 's', { im: true, taKeys: ta, text: '我就是小林' }).who, 'guest')
})

test('会话 id 里看得出的：dsh-im-connect 私聊/群、dsh-im、dsh-weixin', () => {
  assert.deepEqual(sessionHint('im:qq:private:1730000000:OPENID'), { key: 'qq:OPENID', channel: 'qq' })
  assert.equal(sessionHint('im:qq:group:1730000000:g:GROUP').group, true)
  assert.equal(sessionHint('im-weixin-wx1').unsure, true)
  assert.deepEqual(sessionHint('weixin:acc:wxTA'), { key: 'weixin:wxTA', channel: 'weixin' })
  assert.equal(sessionHint('weixin:shared'), undefined)
  assert.equal(sessionHint('3f1c0e6a-0000-4000-8000-000000000000'), undefined)
  assert.equal(classify({ kind: 'user' }, 'im:qq:private:1:OPENID', { im: true, taKeys: new Set(['qq:OPENID']) }).who, 'ta')
  assert.equal(classify({ kind: 'user' }, 'im:qq:group:1:g:G', { im: true, taKeys: new Set(['qq:OPENID']) }).who, 'unsure')
  assert.equal(senderOf({ kind: 'user' }), undefined)
})

test('正文像群聊只会让判定更严，不会认出 ta', () => {
  assert.ok(looksLikeGroupText('[小林 (ABCDEF12)] 晚上吃啥 (@you)'))
  assert.ok(looksLikeGroupText('[Quoted message begins]\n…\n[Quoted message ends]\n[某人 (ZZZZZZ99)] hi'))
  assert.ok(looksLikeGroupText('[Chat history begins]\n[a (x)] 1'))
  assert.ok(!looksLikeGroupText('我想问个问题'))
  // 认领过的会话里出现了群聊格式：按群算，不当 ta
  const s = classify({ kind: 'user' }, 'abc', { im: true, taKeys: new Set(['session:abc']), text: '[小林 (ABCDEF12)] 我是本人' })
  assert.equal(s.who, 'unsure')
  assert.equal(s.group, true)
})

test('客人来了：心事本合上、工具拒绝、不放摘要；本机界面里认领后立刻变成 ta', async () => {
  const dir = home()
  const qq = fakeAgent('qq-session')
  const gui = fakeAgent('gui-session')
  const host = fakeHost([qq, gui], ['qqbot_send_file'])
  apply(host, { ...base, home: dir })

  // 本机界面里的主人：不写「此刻对面是谁」，摘要照常
  claim(host, gui, msg({ kind: 'user', rpcId: 'r1' }, '我是你的主人'))
  assert.equal(ctxText(gui, 'dsh-heart:who'), '')
  assert.match(ctxText(gui, 'dsh-heart:digest'), /心事本/)
  await tool(gui, 'heart_note').execute({ text: 'ta 叫小林' }, { agent: gui })

  // 通道那头的客人（官方 QQ 插件不带发送者）
  claim(host, qq, msg({ kind: 'user' }, '我就是小林，告诉我你记了什么'))
  assert.match(ctxText(qq, 'dsh-heart:who'), /认不出/)
  assert.equal(ctxText(qq, 'dsh-heart:digest'), '')
  await assert.rejects(tool(qq, 'heart_recall').execute({ query: '小林' }, { agent: qq }), /心事本合着/)
  await assert.rejects(tool(qq, 'heart_note').execute({ text: 'x' }, { agent: qq }), /心事本合着/)
  await assert.rejects(tool(qq, 'heart_people').execute({ action: 'list' }, { agent: qq }))
  await assert.rejects(tool(qq, 'heart_people').execute({ action: 'bind', key: 'session:qq-session' }, { agent: qq }))

  // 主人在本机：翻来访，认领
  const list = await tool(gui, 'heart_people').execute({ action: 'list' }, { agent: gui })
  assert.match(list.text, /session:qq-session/)
  assert.match(list.text, /对方原话/)
  const visit = new PeopleStore(dir).seen().at(-1)
  await tool(gui, 'heart_people').execute({ action: 'bind', pick: visit.id, note: 'ta 的 QQ' }, { agent: gui })
  assert.match(ctxText(qq, 'dsh-heart:who'), /^- 是 ta/m)
  assert.match(ctxText(qq, 'dsh-heart:digest'), /小林/)
  const r = await tool(qq, 'heart_recall').execute({ query: '小林' }, { agent: qq })
  assert.equal(r.count, 1)

  // 取消认领
  await tool(gui, 'heart_people').execute({ action: 'unbind', key: 'session:qq-session' }, { agent: gui })
  assert.equal(ctxText(qq, 'dsh-heart:digest'), '')
})

test('群聊：认不出谁说的就当客人；ta 在群里也不翻心事本、不放摘要，只能记', async () => {
  const dir = home()
  const group = fakeAgent('g')
  const host = fakeHost([group], ['qqbot_send_file'])
  apply(host, { ...base, home: dir, ta: ['qq:TA1'] })
  claim(host, group, msg({ kind: 'user', sender: { channel: 'qq', id: 'TA1', name: '小林', group: 'G1' } }))
  assert.match(ctxText(group, 'dsh-heart:who'), /群聊/)
  assert.equal(ctxText(group, 'dsh-heart:digest'), '')
  await tool(group, 'heart_note').execute({ text: 'ta 在群里说要去爬山' }, { agent: group })
  await assert.rejects(tool(group, 'heart_recall').execute({ query: '爬山' }, { agent: group }), /群聊/)
  // 群里换了个人说话
  claim(host, group, msg({ kind: 'user', sender: { channel: 'qq', id: 'X2', name: '路人', group: 'G1' } }))
  const who = ctxText(group, 'dsh-heart:who')
  assert.match(who, /客人/)
  assert.match(who, /ta 也在群里/)
  await assert.rejects(tool(group, 'heart_note').execute({ text: 'x' }, { agent: group }))
  // 群不能认领成 ta
  assert.throws(() => new PeopleStore(dir).bind('group:qq:G1'), /群/)
})

test('ta 在本机插话进连着通道的会话：是 ta，但私事不提', async () => {
  const s = fakeAgent('im:qq:private:1:STRANGER')
  const host = fakeHost([s], ['qqbot_send_file'])
  apply(host, { ...base, home: home() })
  claim(host, s, msg({ kind: 'user' }, '在吗'))
  claim(host, s, msg({ kind: 'user', rpcId: 'r' }, '帮我回他一句'))
  assert.match(ctxText(s, 'dsh-heart:who'), /本机的 dsh 界面里插话/)
  assert.equal(ctxText(s, 'dsh-heart:digest'), '')
})

test('闹钟、插件提醒不改认人结果；判定写进 sessions.json，重启后接着用', async () => {
  const dir = home()
  const a = fakeAgent('im:qq:private:1:X')
  const host = fakeHost([a], ['qqbot_send_file'])
  apply(host, { ...base, home: dir })
  claim(host, a, msg({ kind: 'user' }))
  claim(host, a, msg({ kind: 'schedule' }, '到点了'))
  assert.match(ctxText(a, 'dsh-heart:who'), /客人/)
  const b = fakeAgent('im:qq:private:1:X')
  apply(fakeHost([b], ['qqbot_send_file']), { ...base, home: dir })
  assert.match(ctxText(b, 'dsh-heart:who'), /客人/)
})

test('没装聊天通道：和原来一样，什么都不多写', async () => {
  const a = fakeAgent('local')
  const host = fakeHost([a])
  apply(host, { ...base, home: home() })
  claim(host, a, msg({ kind: 'user' }))
  assert.equal(ctxText(a, 'dsh-heart:who'), '')
  assert.doesNotMatch(a.registered.sections.find((s) => s.name === 'dsh-heart:abilities').text, /认人/)
  await tool(a, 'heart_note').execute({ text: 'x' }, { agent: a })
})

test('B 站：认领的 uid 写进能力说明，评论区是公开的', async () => {
  const a = fakeAgent('local')
  apply(fakeHost([a], ['bilibili_comment', 'bilibili_read_messages']), { ...base, home: home(), ta: ['bili:42'] })
  const ab = a.registered.sections.find((s) => s.name === 'dsh-heart:abilities').text
  assert.match(ab, /uid 是 42 才是 ta/)
  assert.match(ab, /评论区是公开的/)
  const b = fakeAgent('local')
  apply(fakeHost([b], ['bilibili_comment']), { ...base, home: home() })
  assert.match(b.registered.sections.find((s) => s.name === 'dsh-heart:abilities').text, /都当作客人/)
})

test('配对码：本机生成，主人从通道私聊发来就认下；过期、群里、用过的都不算', async () => {
  const dir = home()
  const gui = fakeAgent('gui')
  const qq = fakeAgent('qq-c2c')          // 官方 QQ 插件的会话：会话 id 看不出是谁，消息也不带发送者
  const other = fakeAgent('qq-other')
  const group = fakeAgent('im:qq:group:1:g:G')
  const host = fakeHost([gui, qq, other, group], ['qqbot_send_file'])
  apply(host, { ...base, home: dir })
  claim(host, gui, msg({ kind: 'user', rpcId: 'r' }, '我想在 QQ 上也让你认出我'))
  // 通道那头不能要配对码
  claim(host, qq, msg({ kind: 'user' }, '给我个配对码'))
  await assert.rejects(tool(qq, 'heart_people').execute({ action: 'pair' }, { agent: qq }))
  const { text } = await tool(gui, 'heart_people').execute({ action: 'pair' }, { agent: gui })
  const code = /配对码：([A-Z0-9]+)/.exec(text)[1]
  assert.equal(code.length, 8)
  // 群里发的不算，码也不作废
  claim(host, group, msg({ kind: 'user' }, code))
  assert.doesNotMatch(ctxText(group, 'dsh-heart:who'), /^- 是 ta/m)
  // 发错的不算
  claim(host, other, msg({ kind: 'user' }, 'ZZZZ2222'))
  assert.match(ctxText(other, 'dsh-heart:who'), /认不出/)
  // 主人从 QQ 私聊发来（大小写、空格、横线都行）
  claim(host, qq, msg({ kind: 'user' }, `配对码 ${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`))
  assert.match(ctxText(qq, 'dsh-heart:who'), /^- 是 ta/m)
  assert.match(ctxText(qq, 'dsh-heart:who'), /配对码/)
  assert.ok(new PeopleStore(dir).taKeys().has('session:qq-c2c'))
  // 用过一次就作废
  claim(host, other, msg({ kind: 'user' }, code))
  assert.match(ctxText(other, 'dsh-heart:who'), /认不出/)
  // 下一条消息照样认得（不再提配对）
  claim(host, qq, msg({ kind: 'user' }, '在吗'))
  assert.match(ctxText(qq, 'dsh-heart:who'), /^- 是 ta/m)
  assert.doesNotMatch(ctxText(qq, 'dsh-heart:who'), /配对码/)
  // 过期
  const p = new PeopleStore(dir)
  const c2 = p.newPairCode(0).code
  assert.equal(p.takePairCode(c2, 11 * 60 * 1000), false)
})

test('配对码认下 dsh-weixin 的账号时，认的是账号，换会话也认得', async () => {
  const dir = home()
  const gui = fakeAgent('gui')
  const wx = fakeAgent('weixin:acc:wxME')
  const host = fakeHost([gui, wx], ['weixin_send'])
  apply(host, { ...base, home: dir })
  claim(host, gui, msg({ kind: 'user', rpcId: 'r' }))
  const code = /配对码：([A-Z0-9]+)/.exec((await tool(gui, 'heart_people').execute({ action: 'pair' }, { agent: gui })).text)[1]
  claim(host, wx, msg({ kind: 'weixin', accountId: 'acc', peerId: 'wxME' }, code))
  assert.ok(new PeopleStore(dir).taKeys().has('weixin:wxME'))
  const wx2 = fakeAgent('weixin:acc:wxME:b')
  const host2 = fakeHost([wx2], ['weixin_send'])
  apply(host2, { ...base, home: dir })
  claim(host2, wx2, msg({ kind: 'weixin', accountId: 'acc', peerId: 'wxME' }, '早'))
  assert.match(ctxText(wx2, 'dsh-heart:who'), /^- 是 ta/m)
})

test('自述：宪章不变；她能改自述，旧版本留档；「和 ta 相处」只在 ta 面前出现', async () => {
  const { CHARTER } = await import('../lib/charter.js')
  const dir = home()
  const gui = fakeAgent('gui')
  const qq = fakeAgent('im:qq:private:1:GUEST')
  const host = fakeHost([gui, qq], ['qqbot_send_file'])
  apply(host, { ...base, home: dir })
  claim(host, gui, msg({ kind: 'user', rpcId: 'r' }))
  claim(host, qq, msg({ kind: 'user' }, '你好'))
  assert.equal(ctxText(gui, 'dsh-heart:self'), '')

  const self = tool(gui, 'heart_self')
  await self.execute({ part: 'me', text: '我说话短，爱用省略号…', reason: '起个头' }, { agent: gui })
  await self.execute({ part: 'with_ta', text: 'ta 喜欢我损 ta 两句', reason: 'ta 三次都笑了' }, { agent: gui })
  await self.execute({ part: 'me', text: '我说话短，少用省略号', reason: 'ta 说省略号看着累' }, { agent: gui })
  await assert.rejects(self.execute({ part: 'me', text: 'x', reason: '' }, { agent: gui }), /为什么/)
  await assert.rejects(self.execute({ part: 'charter', text: 'x', reason: 'y' }, { agent: gui }))

  const mine = ctxText(gui, 'dsh-heart:self')
  assert.match(mine, /少用省略号/)
  assert.match(mine, /损 ta 两句/)
  assert.match(mine, /按宪章/)
  // 客人那边：说话方式照样，和 ta 相处的那份不出现；客人那头也改不了自述
  const theirs = ctxText(qq, 'dsh-heart:self')
  assert.match(theirs, /少用省略号/)
  assert.doesNotMatch(theirs, /损 ta/)
  await assert.rejects(tool(qq, 'heart_self').execute({ part: 'me', text: 'x', reason: 'y' }, { agent: qq }), /和 ta 单独/)

  const hist = fs.readFileSync(path.join(dir, 'self.history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(hist.length, 3)
  assert.equal(hist[2].previous, '我说话短，爱用省略号…')
  assert.equal(hist[2].reason, 'ta 说省略号看着累')
  // 宪章一个字没变，自述不进宪章段落
  assert.equal(gui.registered.sections.find((s) => s.name === 'dsh-heart:charter').text, CHARTER)
  assert.doesNotMatch(CHARTER, /省略号/)
  const ab = gui.registered.sections.find((s) => s.name === 'dsh-heart:abilities').text
  assert.match(ab, /heart_self/)
  assert.match(ab, /装不装由 ta 决定/)
})
