// 认人：这一轮对面是 ta、客人，还是认不出来。
//
// 只认通道给的硬信号，对方自称、昵称、正文里的前缀都不算：
//   source.sender = {channel, id, name?, group?}   约定写法，建议 IM 插件照这个带上发送者
//   source.peerId（+ accountId）                   @5havv/dsh-weixin
//   source.principal                               dsh 远程访问的非主人调用方（dsh 只在不是主人时写它）
//   会话 id                                        IM 插件按聊天对象派生的会话：im:<渠道>:<private|group>:…（dsh-im-connect）、
//                                                  im-<平台>-<chatId>（dsh-im）、weixin:<账号>:<对方>（dsh-weixin）
//   source.rpcId 且没有 principal                  dsh 自己的界面（web / tui），坐在这台机器前的人
// 什么都没带的消息（headless、官方 QQ 插件、dsh-wechat、telegram 都是这样）：这台 dsh 没装 IM 通道时
// 当作主人；装了就认不出，按客人对待，等主人在自己电脑上用 heart_people 把那个会话认领下来。
//
// people.json        {ta: [{key, note, at}]}            主人认领的账号（配置里的 ta 另算）
// people.seen.jsonl  {id, at, key, channel, name, session, group, who, quote}   最近认不出或是客人的来访
// sessions.json      {<会话 id>: {who, key, channel, name, group, keys}}         每个会话最后一次认出的结果，重启后接着用

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// 工具名里带这些字的，说明这台 dsh 接着聊天通道（只用来决定"什么都没带的消息"算不算主人）
export const IM_TOOL = /(qq|onebot|napcat|wechat|weixin|wecom|telegram|discord|slack|feishu|lark|dingtalk|matrix|line_|kook|im_send|imconnect)/i
export const BILI_TOOL = /^bilibili_/

export const CHANNEL_NAME = {
  qq: 'QQ', weixin: '微信', wechat: '微信', telegram: 'Telegram', feishu: '飞书', lark: '飞书', dingtalk: '钉钉',
  wecom: '企业微信', discord: 'Discord', slack: 'Slack', bili: 'B 站', principal: '远程访问', session: '聊天通道',
}

const MAX_SEEN = 200
const SEEN_GAP_MS = 60 * 60 * 1000
const PAIR_TTL_MS = 10 * 60 * 1000
// 去掉 0/O、1/I/L 这类容易看错的字
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function clean(s, max = 40) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max)
}

/** 统一成 渠道:编号。session:<会话 id> 原样保留（会话 id 里本来就有冒号）。 */
export function normKey(key) {
  const s = String(key ?? '').trim()
  const m = /^([a-z][a-z0-9_-]*):(.+)$/i.exec(s)
  if (!m) return ''
  const channel = m[1].toLowerCase() === 'wechat' ? 'weixin' : m[1].toLowerCase()
  return `${channel}:${m[2].trim()}`
}

export function isGroupKey(key) {
  return /^(group|chat):/.test(key) || /:g:|:group:/.test(key)
}

/** 消息自己带着的发送者。没有就返回 undefined。 */
export function senderOf(source) {
  if (!source || typeof source !== 'object') return undefined
  const s = source.sender
  if (s && typeof s === 'object' && s.id !== undefined && s.channel) {
    const channel = normKey(`${s.channel}:x`).split(':')[0]
    return { key: `${channel}:${s.id}`, channel, name: clean(s.name), group: s.group ? String(s.group) : undefined }
  }
  if (source.peerId !== undefined && (source.kind === 'weixin' || source.accountId !== undefined)) {
    return { key: `weixin:${source.peerId}`, channel: 'weixin', name: clean(source.peerName ?? source.name) }
  }
  if (source.principal && typeof source.principal === 'object') {
    const p = source.principal
    const id = p.id ?? p.name ?? p.subject ?? ''
    return { key: `principal:${p.kind ?? 'remote'}:${id}`, channel: 'principal', name: clean(p.name ?? p.label ?? p.kind), remote: true }
  }
  return undefined
}

/** IM 插件按聊天对象派生的会话 id 里能看出的东西。看不出就返回 undefined。 */
export function sessionHint(sessionId) {
  const id = String(sessionId ?? '')
  let m = /^im:([^:]+):(private|group|c2c|dm):(?:\d+:)?(.+)$/.exec(id)     // dsh-im-connect
  if (m) {
    const group = m[2] === 'group' || m[3].startsWith('g:')
    return group ? { key: `group:${m[1]}:${m[3]}`, channel: m[1], group: true } : { key: `${m[1]}:${m[3]}`, channel: m[1] }
  }
  m = /^im-([a-z]+)-(.+)$/.exec(id)                                         // dsh-im（一个聊天一个会话，看不出是不是群）
  if (m) return { key: `chat:${m[1]}:${m[2]}`, channel: m[1], unsure: true }
  m = /^weixin:([^:]+):([^:]+?)(?::b)?$/.exec(id)                            // @5havv/dsh-weixin
  if (m && m[2] !== 'shared') return { key: `weixin:${m[2]}`, channel: 'weixin' }
  return undefined
}

/**
 * 正文像不像群聊（官方 QQ 插件把群消息写成「[昵称 (openid)] 内容」，还会带「[Chat history begins]」）。
 * 正文谁都能伪造，所以它只能让判定更严（当成群），从不用来认出 ta。
 */
export function looksLikeGroupText(text) {
  const s = String(text ?? '')
  if (s.includes('[Chat history begins]')) return true
  const body = s.replace(/^\s*\[Quoted message begins\][\s\S]*?\[Quoted message ends\]\s*/, '')
  return /^\s*\[[^\]\n]{1,64} \([A-Za-z0-9_-]{6,}\)\]/.test(body)
}

/**
 * 这条用户消息是谁发的。
 * @returns {{who: 'ta'|'guest'|'unsure', key?: string, channel?: string, name?: string, group?: boolean, local?: boolean}}
 */
export function classify(source, sessionId, { im = false, untagged = 'auto', taKeys = new Set(), text = '' } = {}) {
  const sender = senderOf(source)
  const hint = sessionHint(sessionId)
  const boundSession = taKeys.has(`session:${sessionId}`)
  if (sender) {
    const group = Boolean(sender.group || hint?.group)
    const who = taKeys.has(sender.key) ? 'ta' : 'guest'
    return { who, key: sender.key, channel: sender.channel, name: sender.name, group }
  }
  // dsh 自己的界面：提交者是主人时 dsh 不写 principal
  if (source?.rpcId !== undefined) return { who: 'ta', local: true }
  if (hint) {
    if (hint.group) return { who: 'unsure', key: hint.key, channel: hint.channel, group: true }
    if (taKeys.has(hint.key) || boundSession) return { who: 'ta', key: hint.key, channel: hint.channel }
    return { who: hint.unsure ? 'unsure' : 'guest', key: hint.key, channel: hint.channel }
  }
  if (looksLikeGroupText(text)) return { who: 'unsure', key: `group:session:${sessionId}`, channel: 'session', group: true }
  if (boundSession) return { who: 'ta', key: `session:${sessionId}`, channel: 'session' }
  const bare = untagged === 'auto' ? (im ? 'unsure' : 'ta') : untagged
  return bare === 'ta' ? { who: 'ta', local: true } : { who: 'unsure', key: `session:${sessionId}`, channel: 'session' }
}

export class PeopleStore {
  constructor(dir) {
    this.dir = dir
    this.sessions = this.readJson('sessions.json', {})
    this.lastSeen = new Map()
    this.pairing = undefined   // {code, until}：只在内存里，重启就作废
  }

  /** 本机生成一次性配对码，10 分钟内有效，用一次就作废。 */
  newPairCode(now = Date.now()) {
    const bytes = crypto.randomBytes(8)
    const code = [...bytes].map((b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('')
    this.pairing = { code, until: now + PAIR_TTL_MS }
    return { code, minutes: PAIR_TTL_MS / 60000 }
  }

  /** 这条消息里有没有有效的配对码。命中就作废这个码。 */
  takePairCode(text, now = Date.now()) {
    const p = this.pairing
    if (!p) return false
    if (now > p.until) {
      this.pairing = undefined
      return false
    }
    const s = String(text ?? '').toUpperCase().replace(/[\s-]/g, '')
    if (!s.includes(p.code)) return false
    this.pairing = undefined
    return true
  }

  file(name) {
    return path.join(this.dir, name)
  }

  readJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'))
    } catch {
      return fallback
    }
  }

  writeJson(name, value) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const p = this.file(name)
    fs.writeFileSync(p + '.tmp', JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(p + '.tmp', p)
  }

  claimed() {
    const v = this.readJson('people.json', {})
    return Array.isArray(v.ta) ? v.ta.filter((e) => e && typeof e.key === 'string') : []
  }

  /** 配置里的 ta 加上主人认领过的。 */
  taKeys(configured = []) {
    return new Set([...configured, ...this.claimed().map((e) => e.key)].map(normKey).filter(Boolean))
  }

  bind(key, note = '') {
    const k = normKey(key)
    if (!k) throw new Error('账号要写成 渠道:编号，例如 qq:xxxx 或 session:<会话 id>')
    if (isGroupKey(k)) throw new Error('这是一个群，不是一个人；群里的人分不出来，不能认领成 ta')
    const list = this.claimed()
    if (!list.some((e) => e.key === k)) {
      list.push({ key: k, note: clean(note, 80), at: new Date().toISOString() })
      this.writeJson('people.json', { ta: list })
    }
    return k
  }

  unbind(key) {
    const k = normKey(key)
    const list = this.claimed()
    const rest = list.filter((e) => e.key !== k)
    if (rest.length === list.length) return false
    this.writeJson('people.json', { ta: rest })
    return true
  }

  seen() {
    const rows = []
    try {
      for (const line of fs.readFileSync(this.file('people.seen.jsonl'), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          rows.push(JSON.parse(line))
        } catch {}
      }
    } catch {}
    return rows
  }

  /** 记下认不出或是客人的来访，同一个账号一小时记一次，只留最近 200 条。 */
  noteVisit(state, session, quote) {
    if (state.who === 'ta' || !state.key) return
    const last = this.lastSeen.get(state.key)
    if (last !== undefined && Date.now() - last < SEEN_GAP_MS) return
    this.lastSeen.set(state.key, Date.now())
    const rows = this.seen()
    const row = {
      id: (rows.at(-1)?.id ?? 0) + 1, at: new Date().toISOString(), key: state.key, channel: state.channel,
      name: state.name || undefined, session, group: state.group || undefined, who: state.who, quote: clean(quote, 30),
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const keep = [...rows, row].slice(-MAX_SEEN)
    const p = this.file('people.seen.jsonl')
    fs.writeFileSync(p + '.tmp', keep.map((r) => JSON.stringify(r)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(p + '.tmp', p)
  }

  sessionState(sessionId) {
    return this.sessions[sessionId]
  }

  saveSession(sessionId, state) {
    const prev = this.sessions[sessionId]
    const next = { who: state.who, key: state.key, channel: state.channel, name: state.name, group: state.group || undefined,
      local: state.local || undefined, keys: state.keys?.length ? state.keys : undefined, taHere: state.taHere || undefined,
      watched: state.watched || undefined }
    if (JSON.stringify(prev) === JSON.stringify(next)) return
    this.sessions[sessionId] = next
    try {
      this.writeJson('sessions.json', this.sessions)
    } catch {
      // 写不了就只在内存里，重启后从下一条消息重新认
    }
  }
}
