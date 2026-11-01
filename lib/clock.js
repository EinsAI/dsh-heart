// 时钟和 ta 的作息：dsh 不在每一步告诉模型现在几点，插件自己给（精确到小时，免得每分钟都变）。
//
// rhythm.json  {days: {"2026-10-31": [24 个计数]}}  ta 单独和我说话时，每条消息落在哪个钟点；只记钟点，不记内容，留 14 天

import fs from 'node:fs'
import path from 'node:path'

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const KEEP_DAYS = 14

export function timeZoneOf(config = {}) {
  const tz = String(config.timeZone ?? '').trim()
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    } catch {}
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** 某个时刻在这个时区里是几号几点。 */
export function clock(timeZone, at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(at).map((p) => [p.type, p.value]))
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const hour = Number(parts.hour) % 24
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
  return { date, hour, weekday: WEEK[wd], text: `${date} ${WEEK[wd]} ${hour} 点`, timeZone }
}

export class Rhythm {
  constructor(dir) {
    this.dir = dir
  }

  file() {
    return path.join(this.dir, 'rhythm.json')
  }

  read() {
    try {
      const v = JSON.parse(fs.readFileSync(this.file(), 'utf8'))
      return v && typeof v.days === 'object' ? v : { days: {} }
    } catch {
      return { days: {} }
    }
  }

  note(c) {
    const v = this.read()
    const day = (v.days[c.date] ??= Array(24).fill(0))
    day[c.hour] = (day[c.hour] ?? 0) + 1
    const keep = Object.keys(v.days).sort().slice(-KEEP_DAYS)
    v.days = Object.fromEntries(keep.map((d) => [d, v.days[d]]))
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.file() + '.tmp', JSON.stringify(v) + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(this.file() + '.tmp', this.file())
  }

  /**
   * 最近 7 天 ta 常在的钟点，连着的并成一段，例如「10–13 点、20–24 点」。
   * 一个钟点算"常在"：至少两天在这个钟点说过话。天数不够、看不出来时返回空。
   */
  summary(today, days = 7) {
    const v = this.read()
    const end = new Date(`${today}T00:00:00Z`).getTime()
    const recent = Object.entries(v.days).filter(([d]) => {
      const t = new Date(`${d}T00:00:00Z`).getTime()
      return t <= end && t > end - days * 86400000
    })
    if (recent.length < 2) return ''
    const daysAt = Array(24).fill(0)
    for (const [, counts] of recent) counts.forEach((n, h) => { if (n > 0) daysAt[h]++ })
    const on = daysAt.map((n) => n >= 2)
    const spans = []
    for (let h = 0; h < 24; h++) {
      if (!on[h]) continue
      let e = h
      while (e + 1 < 24 && on[e + 1]) e++
      spans.push(`${h}–${e + 1} 点`)
      h = e
    }
    return spans.length ? `${spans.join('、')}（最近 ${recent.length} 天里，至少两天在这些钟点和我说过话）` : ''
  }
}
