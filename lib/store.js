// 心事本：纯文件存储，放在 <DSH_HOME>/heart/ 下，跨项目、跨会话共用。
//
// notes.jsonl       随手记，一行一条 {id, at, session, text}
// summaries.jsonl   小结和追加的理解 {id, at, session, text, upTo, of?}
//                   upTo = 写这份小结时最后一条随手记的编号；之后的随手记算"还没写进小结"
//                   of   = 这条是对哪份小结的新理解（只追加，原文不改）
// longterm.md       长期笔记的当前版本；每次改写的旧版本和理由追加进 longterm.history.jsonl
// self.md           她的自述：我是怎样的、怎么说话（对谁都一样）
// self-with-ta.md   她的自述：和 ta 相处里摸索出来的（只在和 ta 单独说话时放在眼前）
//                   两份的旧版本和理由都追加进 self.history.jsonl {part, reason, previous}
// promises.jsonl    约定本：{kind:'item', type, text, due?} 和后来追加的 {kind:'update', of, status, note}
// tact.jsonl        提起的分寸：{kind:'rule', topic, level, why, replaces?} 和提起后 ta 的反应 {kind:'note', of, text}
// review.jsonl      复盘记录 {id, at, session, text}：上次复盘以来的东西由这里切分
//
// 文件都是追加写，用户可以直接打开看。没有数据库，没有网络。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_TEXT = 4000
const SELF_MAX = 3000
const SELF_FILE = { me: 'self.md', with_ta: 'self-with-ta.md' }

export const PROMISE_TYPE = { habit: '习惯', joke: '梗', ta: 'ta 答应的', me: '我答应的', rule: '我们的规矩' }
export const PROMISE_STATUS = { done: '做到了', dropped: '不作数了', note: '补一笔' }
export const TACT_LEVEL = { open: '直接说', light: '轻轻带过', tone: '只影响语气，嘴上不提', wait: '等 ta 问起' }
const DUE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/

function stamp(at) {
  return String(at ?? '').slice(0, 16).replace('T', ' ')
}

function now() {
  return new Date().toISOString()
}

function clip(text, max = MAX_TEXT) {
  const s = String(text ?? '').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 别的记忆插件的个人记忆目录（只读）。只找"关于这个人"的那一层，不碰项目级记忆。
 * - @fooxe/dsh-memory 的用户层：$DSH_MEMORY_USER_DIR 或 <DSH_HOME>/memory/memories/*.md
 * - dsh-mnemon 的运行时记忆：~/.mnemon/sources/<实例>/runtime/USER.md
 * extra 是用户在配置里另加的目录或文件。
 */
export function linkedMemoryFiles(dshHome, extra = [], home = os.homedir()) {
  const files = []
  const addDir = (dir) => {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) files.push(path.join(dir, f))
    } catch {
      // 没装或没有这个目录
    }
  }
  const addFile = (f) => {
    try {
      if (fs.statSync(f).isFile()) files.push(f)
    } catch {}
  }
  addDir(path.join(process.env.DSH_MEMORY_USER_DIR || path.join(dshHome, 'memory'), 'memories'))
  try {
    for (const inst of fs.readdirSync(path.join(home, '.mnemon', 'sources'))) {
      addFile(path.join(home, '.mnemon', 'sources', inst, 'runtime', 'USER.md'))
    }
  } catch {}
  for (const p of extra) {
    try {
      fs.statSync(p).isDirectory() ? addDir(p) : addFile(p)
    } catch {}
  }
  return [...new Set(files)]
}

export class HeartStore {
  constructor(dir, linked = () => []) {
    this.dir = dir
    this.linked = linked     // () => 只读的个人记忆文件列表
    this.cache = new Map()   // 文件名 → {mtimeMs, size, rows}
  }

  /** 个人记忆（别的插件写的），按段落切开，只读。 */
  linkedItems() {
    const items = []
    for (const f of this.linked()) {
      let text
      try {
        text = fs.readFileSync(f, 'utf8')
      } catch {
        continue
      }
      text = text.replace(/^---\n[\s\S]*?\n---\n/, '')   // 去掉 dsh-memory 的 frontmatter
      const where = path.basename(path.dirname(f)) === 'runtime' ? 'mnemon' : path.basename(f, '.md')
      text.split(/\n\s*\n|\n§\n/).map((p) => p.trim()).filter(Boolean)
        .forEach((para, i) => items.push({ kind: '个人记忆', id: `${where}:${i + 1}`, text: para }))
    }
    return items
  }

  file(name) {
    return path.join(this.dir, name)
  }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  readJsonl(name) {
    const p = this.file(name)
    let st
    try {
      st = fs.statSync(p)
    } catch {
      return []
    }
    const hit = this.cache.get(name)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rows
    const rows = []
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // 手改坏的一行跳过，不让整本读不出来
      }
    }
    this.cache.set(name, { mtimeMs: st.mtimeMs, size: st.size, rows })
    return rows
  }

  append(name, row) {
    this.ensure()
    const rows = this.readJsonl(name)
    const id = (rows.at(-1)?.id ?? 0) + 1
    const full = { id, at: now(), ...row }
    fs.appendFileSync(this.file(name), JSON.stringify(full) + '\n', { encoding: 'utf8', mode: 0o600 })
    return full
  }

  notes() {
    return this.readJsonl('notes.jsonl')
  }

  summaries() {
    return this.readJsonl('summaries.jsonl')
  }

  longterm() {
    try {
      return fs.readFileSync(this.file('longterm.md'), 'utf8').trim()
    } catch {
      return ''
    }
  }

  addNote(text, session) {
    const t = clip(text)
    if (!t) throw new Error('随手记要写内容')
    return this.append('notes.jsonl', { session, text: t })
  }

  addSummary(text, session, of) {
    const t = clip(text, 8000)
    if (!t) throw new Error('小结要写内容')
    if (of !== undefined) {
      const target = this.summaries().find((s) => s.id === of && s.of === undefined)
      if (!target) throw new Error(`没有编号为 ${of} 的小结`)
      return this.append('summaries.jsonl', { session, text: t, of })
    }
    const upTo = this.notes().at(-1)?.id ?? 0
    return this.append('summaries.jsonl', { session, text: t, upTo })
  }

  setLongterm(text, reason, session) {
    const t = clip(text, 12000)
    if (!t) throw new Error('长期笔记要写完整的新版本')
    this.ensure()
    const previous = this.longterm()
    this.append('longterm.history.jsonl', { session, reason: clip(reason, 500), previous })
    const p = this.file('longterm.md')
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, t + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, p)
    return { chars: t.length }
  }

  self(part = 'me') {
    try {
      return fs.readFileSync(this.file(SELF_FILE[part]), 'utf8').trim()
    } catch {
      return ''
    }
  }

  setSelf(part, text, reason, session) {
    const name = SELF_FILE[part]
    if (!name) throw new Error('part 只能是 me 或 with_ta')
    const t = clip(text, SELF_MAX)
    if (!t) throw new Error('自述要写完整的新版本')
    const why = clip(reason, 500)
    if (!why) throw new Error('改自述要写为什么')
    this.ensure()
    const previous = this.self(part)
    this.append('self.history.jsonl', { session, part, reason: why, previous })
    const p = this.file(name)
    fs.writeFileSync(p + '.tmp', t + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(p + '.tmp', p)
    return { chars: t.length }
  }

  /** 每一步放在她眼前的自述。withTa = 此刻是和 ta 单独说话。 */
  selfText(withTa) {
    const me = this.self('me')
    const ta = withTa ? this.self('with_ta') : ''
    if (!me && !ta) return ''
    const parts = ['# 我的自述（我自己写的，随相处改；和宪章冲突时按宪章）']
    if (me) parts.push('## 我是怎样的、怎么说话\n' + me)
    if (ta) parts.push('## 和 ta 相处\n' + ta)
    return parts.join('\n\n')
  }

  // ---- 约定本 ----

  addPromise(type, text, due, session) {
    if (!PROMISE_TYPE[type]) throw new Error(`type 只能是 ${Object.keys(PROMISE_TYPE).join(' / ')}`)
    const t = clip(text, 500)
    if (!t) throw new Error('约定要写内容')
    let d
    if (due !== undefined && String(due).trim() !== '') {
      const m = DUE.exec(String(due).trim())
      if (!m) throw new Error('到期时间写成 2026-11-01 或 2026-11-01 21:00')
      d = m[2] ? `${m[1]} ${m[2]}` : m[1]
    }
    return this.append('promises.jsonl', { session, kind: 'item', type, text: t, ...(d ? { due: d } : {}) })
  }

  updatePromise(of, status, note, session) {
    if (!PROMISE_STATUS[status]) throw new Error(`status 只能是 ${Object.keys(PROMISE_STATUS).join(' / ')}`)
    const item = this.readJsonl('promises.jsonl').find((r) => r.kind === 'item' && r.id === of)
    if (!item) throw new Error(`没有编号为 ${of} 的约定`)
    return this.append('promises.jsonl', { session, kind: 'update', of, status, note: clip(note, 500) || undefined })
  }

  /** 每条约定加上它后来的追加；status = 最后一次 done/dropped，没有就是还算数。 */
  promises() {
    const rows = this.readJsonl('promises.jsonl')
    const items = rows.filter((r) => r.kind === 'item').map((r) => ({ ...r, updates: [] }))
    const byId = new Map(items.map((r) => [r.id, r]))
    for (const u of rows) {
      if (u.kind !== 'update') continue
      const it = byId.get(u.of)
      if (!it) continue
      it.updates.push(u)
      if (u.status !== 'note') it.status = u.status
    }
    return items
  }

  // ---- 提起的分寸 ----

  addTact(topic, level, why, session, replaces) {
    if (!TACT_LEVEL[level]) throw new Error(`level 只能是 ${Object.keys(TACT_LEVEL).join(' / ')}`)
    const tp = clip(topic, 200)
    if (!tp) throw new Error('写清是哪件事')
    const rows = this.readJsonl('tact.jsonl')
    if (replaces !== undefined && !rows.some((r) => r.kind === 'rule' && r.id === replaces)) throw new Error(`没有编号为 ${replaces} 的分寸`)
    return this.append('tact.jsonl', { session, kind: 'rule', topic: tp, level, why: clip(why, 500), ...(replaces !== undefined ? { replaces } : {}) })
  }

  addTactNote(of, text, session) {
    const t = clip(text, 500)
    if (!t) throw new Error('写下 ta 的反应')
    if (!this.readJsonl('tact.jsonl').some((r) => r.kind === 'rule' && r.id === of)) throw new Error(`没有编号为 ${of} 的分寸`)
    return this.append('tact.jsonl', { session, kind: 'note', of, text: t })
  }

  /** 现在算数的分寸（被新写的一条替换掉的不算），各带上提起后的反应。 */
  tacts() {
    const rows = this.readJsonl('tact.jsonl')
    const replaced = new Set(rows.filter((r) => r.kind === 'rule' && r.replaces !== undefined).map((r) => r.replaces))
    const notes = new Map()
    for (const r of rows) if (r.kind === 'note') notes.set(r.of, [...(notes.get(r.of) ?? []), r])
    // 改分寸时新写的一条接着看旧的那条的反应
    const chain = (r) => {
      const out = []
      for (let cur = r; cur; cur = cur.replaces !== undefined ? rows.find((x) => x.kind === 'rule' && x.id === cur.replaces) : undefined) {
        out.unshift(...(notes.get(cur.id) ?? []))
      }
      return out
    }
    return rows.filter((r) => r.kind === 'rule' && !replaced.has(r.id)).map((r) => ({ ...r, notes: chain(r) }))
  }

  // ---- 复盘 ----

  addReview(text, session) {
    const t = clip(text, 2000)
    if (!t) throw new Error('写一句这次复盘做了什么')
    return this.append('review.jsonl', { session, text: t })
  }

  lastReviewAt() {
    return this.readJsonl('review.jsonl').at(-1)?.at
  }

  /** 上次复盘以来新写的（随手记、小结、约定、分寸）。 */
  sinceReview() {
    const after = this.lastReviewAt() ?? ''
    const newer = (r) => String(r.at ?? '') > after
    return {
      since: after || undefined,
      notes: this.notes().filter(newer),
      summaries: this.summaries().filter(newer),
      promises: this.readJsonl('promises.jsonl').filter(newer),
      tact: this.readJsonl('tact.jsonl').filter(newer),
    }
  }

  /** 最早一条还没复盘的东西是什么时候写的；没有就是 undefined。 */
  oldestUnreviewed() {
    const s = this.sinceReview()
    const ats = [...s.notes, ...s.summaries, ...s.promises, ...s.tact].map((r) => r.at).filter(Boolean).sort()
    return ats[0]
  }

  /** 还没写进小结的随手记。 */
  pendingNotes() {
    const upTo = this.summaries().filter((s) => s.of === undefined).at(-1)?.upTo ?? 0
    return this.notes().filter((n) => n.id > upTo)
  }

  /**
   * 翻心事本：按关键词命中数排序，同分取新的。query 按空白切词；中文没有空白时，
   * 再按两字一组切，粗糙但不依赖分词库。
   */
  recall(query, limit = 8) {
    const q = String(query ?? '').trim().toLowerCase()
    if (!q) return []
    const terms = new Set(q.split(/\s+/).filter(Boolean))
    for (const word of [...terms]) {
      if (/[一-鿿]/.test(word) && word.length > 2) {
        for (let i = 0; i + 2 <= word.length; i++) terms.add(word.slice(i, i + 2))
      }
    }
    const items = [
      ...this.notes().map((r) => ({ kind: '随手记', ...r })),
      ...this.summaries().map((r) => ({ kind: r.of === undefined ? '小结' : '新理解', ...r })),
    ]
    const lt = this.longterm()
    if (lt) {
      lt.split(/\n\s*\n/).forEach((para, i) => items.push({ kind: '长期笔记', id: i + 1, text: para }))
    }
    for (const p of this.promises()) {
      const tail = p.updates.map((u) => `；${stamp(u.at)} ${PROMISE_STATUS[u.status]}${u.note ? `：${u.note}` : ''}`).join('')
      items.push({ kind: `约定（${PROMISE_TYPE[p.type]}）`, id: p.id, at: p.at, text: `${p.text}${p.due ? `（到期 ${p.due}）` : ''}${tail}` })
    }
    for (const r of this.readJsonl('tact.jsonl')) {
      if (r.kind === 'rule') items.push({ kind: '分寸', id: r.id, at: r.at, text: `${r.topic}：${TACT_LEVEL[r.level]}${r.why ? `（${r.why}）` : ''}${r.replaces !== undefined ? `，替换分寸#${r.replaces}` : ''}` })
      else items.push({ kind: '分寸的反应', id: r.of, at: r.at, text: r.text })
    }
    items.push(...this.linkedItems())
    const scored = []
    for (const it of items) {
      const text = String(it.text).toLowerCase()
      let score = 0
      for (const t of terms) if (text.includes(t)) score += t.length
      if (score > 0) scored.push({ score, it })
    }
    scored.sort((a, b) => b.score - a.score || String(b.it.at ?? '').localeCompare(String(a.it.at ?? '')))
    return scored.slice(0, Math.max(1, Math.min(limit, 30))).map(({ it }) => it)
  }

  /** 每一步放在她眼前的摘要：长期笔记 + 最近几份小结 + 还没写进小结的随手记，超长从旧的砍。 */
  digest(maxChars = 6000, recentSummaries = 3, today = '') {
    const lt = this.longterm()
    const promises = this.promises().filter((p) => p.status === undefined)
    const tacts = this.tacts()
    const sums = this.summaries()
    const later = new Map()
    for (const s of sums) if (s.of !== undefined) later.set(s.of, [...(later.get(s.of) ?? []), s])
    const recent = sums.filter((s) => s.of === undefined).slice(-recentSummaries)
    const pending = this.pendingNotes()
    if (!lt && recent.length === 0 && pending.length === 0 && promises.length === 0 && tacts.length === 0) {
      return '# 我的心事本\n还是空的。我们刚认识。'
    }
    const parts = ['# 我的心事本（摘要；更早的用 heart_recall 翻）']
    parts.push('## 长期笔记\n' + (lt || '（还没有）'))
    if (recent.length) {
      parts.push('## 最近的小结\n' + recent.map((s) => {
        const extra = (later.get(s.id) ?? []).map((r) => `  后来的理解（${r.at.slice(0, 10)}）：${r.text}`).join('\n')
        return `- 小结#${s.id}（${s.at.slice(0, 16).replace('T', ' ')}）：${s.text}` + (extra ? '\n' + extra : '')
      }).join('\n'))
    }
    if (promises.length) {
      // 有到期的按到期排在前面，过期的标出来；习惯和梗只留最近 12 条
      const dated = promises.filter((p) => p.due).sort((a, b) => a.due.localeCompare(b.due))
      const rest = promises.filter((p) => !p.due).slice(-12)
      parts.push('## 约定、习惯和梗（现在还算数的）\n' + [...dated, ...rest].map((p) => {
        const late = p.due && today && p.due.slice(0, 10) < today ? '，已经过了' : (p.due && today && p.due.slice(0, 10) === today ? '，就是今天' : '')
        const last = p.updates.at(-1)
        return `- 约定#${p.id}［${PROMISE_TYPE[p.type]}］${p.text}${p.due ? `（到期 ${p.due}${late}）` : ''}${last?.note ? `；后来：${last.note}` : ''}`
      }).join('\n'))
    }
    if (tacts.length) {
      parts.push('## 提起的分寸\n' + tacts.slice(-10).map((r) => {
        const last = r.notes.at(-1)
        const quiet = r.level === 'tone' || r.level === 'wait' ? '（不提，连「我不提」也不说）' : ''
        return `- 分寸#${r.id} ${r.topic}：${TACT_LEVEL[r.level]}${quiet}${last ? `；上次提起时：${last.text}` : ''}`
      }).join('\n'))
    }
    if (pending.length) {
      parts.push('## 还没写进小结的随手记\n' + pending.map((n) => `- 随手记#${n.id}（${n.at.slice(0, 16).replace('T', ' ')}）：${n.text}`).join('\n'))
    }
    let out = parts.join('\n\n')
    if (out.length > maxChars) {
      // 长期笔记优先保留，随手记从最旧的开始丢
      out = out.slice(0, Math.floor(maxChars * 0.4)) + '\n…（中间省略，用 heart_recall 翻）…\n' + out.slice(-Math.floor(maxChars * 0.6))
    }
    return out
  }
}
