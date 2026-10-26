// 心事本：纯文件存储，放在 <DSH_HOME>/heart/ 下，跨项目、跨会话共用。
//
// notes.jsonl       随手记，一行一条 {id, at, session, text}
// summaries.jsonl   小结和追加的理解 {id, at, session, text, upTo, of?}
//                   upTo = 写这份小结时最后一条随手记的编号；之后的随手记算"还没写进小结"
//                   of   = 这条是对哪份小结的新理解（只追加，原文不改）
// longterm.md       长期笔记的当前版本；每次改写的旧版本和理由追加进 longterm.history.jsonl
//
// 文件都是追加写，用户可以直接打开看。没有数据库，没有网络。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_TEXT = 4000

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
  digest(maxChars = 6000, recentSummaries = 3) {
    const lt = this.longterm()
    const sums = this.summaries()
    const later = new Map()
    for (const s of sums) if (s.of !== undefined) later.set(s.of, [...(later.get(s.of) ?? []), s])
    const recent = sums.filter((s) => s.of === undefined).slice(-recentSummaries)
    const pending = this.pendingNotes()
    if (!lt && recent.length === 0 && pending.length === 0) {
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
