import { createHash } from 'node:crypto'
import { parseLooseJSON } from './json-repair'

export const STYLE_DOC = 'style_profile'
export const LEGACY_STYLE_SAMPLE = 'legacy-manual-reference'
export const STYLE_KINDS = ['通用', '对话', '动作', '描写', '心理'] as const
type StyleKind = typeof STYLE_KINDS[number]
export const STYLE_DIMENSIONS = ['叙述语气', '对话语气', '场景描写', '外貌与体态', '动作描写'] as const
type StyleDimension = typeof STYLE_DIMENSIONS[number]
interface StyleEvidence { sample_id: string; quote: string }
export interface StyleSample { id: string; source: number; start: number; text: string; enabled: boolean; manual?: boolean; preferred?: boolean }
export interface StyleObservation extends StyleEvidence { advice: string; kind: StyleKind; dimension?: StyleDimension; evidence?: StyleEvidence[] }
export interface StyleProfile { version: 1; samples: StyleSample[]; observations: StyleObservation[] }

/** Bounded, distributed original passages; no model-generated text can become an example. */
export function sampleStyleSources(content: string): StyleSample[] {
  const parts = content.split('\n\n---\n\n')
  const nonempty = parts.map((_, i) => i).filter(i => parts[i].trim())
  if (!nonempty.length) return []
  const indices = nonempty.length <= 12 ? nonempty : Array.from({length: 12}, (_, i) => nonempty[Math.round(i * (nonempty.length - 1) / 11)])
  const perFile = Math.max(1, Math.floor(12 / indices.length)), samples: StyleSample[] = [], seen = new Set<string>()
  for (const source of indices) {
    const part = parts[source], count = Math.min(perFile, Math.ceil(part.length / 1200))
    for (let i = 0; i < count; i++) {
      let start = count === 1 ? 0 : Math.floor(i * Math.max(0, part.length - 1200) / (count - 1))
      if (start > 0) {
        const boundary = part.slice(start, start + 180).search(/[。！？\n]/u)
        if (boundary >= 0) start += boundary + 1
      }
      let end = Math.min(part.length, start + 1200)
      if (end < part.length) {
        const tail = part.slice(Math.max(start, end - 180), end), matches = [...tail.matchAll(/[。！？\n]/gu)]
        if (matches.length) end = end - tail.length + matches.at(-1)!.index! + 1
      }
      const raw = part.slice(start, end), text = raw.trim()
      start += raw.length - raw.trimStart().length
      if (!text || seen.has(text)) continue
      seen.add(text); samples.push({id: `S${samples.length + 1}`, source: source + 1, start, text, enabled: true})
    }
  }
  return samples
}

/** The model selects IDs; only this program copies the actual original sentences. */
export function styleEvidenceCatalog(samples: StyleSample[]) {
  return samples.flatMap(sample => {
    const sentences = sample.text.match(/[^。！？!?\n]+[。！？!?]?[”’」』"']*/gu) || []
    return sentences.flatMap(sentence => {
      const chars = Array.from(sentence), chunks: string[] = []
      for (let i = 0; i < chars.length; i += 200) chunks.push(chars.slice(i, i + 200).join('').trim())
      return chunks.filter(text => text.length >= 4)
    }).map((quote, i) => ({id: `${sample.id}.${i + 1}`, sample_id: sample.id, quote}))
  })
}

export function styleAnalysisInput(samples: StyleSample[]) {
  const catalog = styleEvidenceCatalog(samples)
  return JSON.stringify(samples.map(({id, source, start}) => ({id, source, start,
    sentences: catalog.filter(item => item.sample_id === id).map(({id, quote}) => ({id, text: quote})),
  })))
}

// Older saved profiles use literal quotes; new extraction must use numbered evidence.
export function parseStyleAnalysis(raw: string, samples: StyleSample[], onInvalid?: () => void, indexed = false): StyleProfile {
  // Repair only known malformed string-field delimiters; never synthesize advice or evidence.
  const parsed = parseLooseJSON<any>(raw) || parseLooseJSON<any>(raw.replace(/"(advice|dimension)：/g, '"$1":"').replace(/"advice"\s*:\s*：\s*/g, '"advice":"'))
  if (!Array.isArray(parsed?.observations) || parsed.observations.length > 16) throw new Error('文风分析格式无效，原指南未改动，请重试')
  const catalog = new Map(styleEvidenceCatalog(samples).map(item => [item.id, item]))
  const grounded = (v: any) => typeof v?.sample_id === 'string' && typeof v.quote === 'string' && v.quote.trim().length >= 4 && v.quote.length <= 600 && samples.some(s => s.id === v.sample_id && s.text.includes(v.quote.trim()))
  const observations: StyleObservation[] = parsed.observations.flatMap((item: any) => {
    let evidence: StyleEvidence[] = []
    let valid = typeof item?.advice === 'string' && !!item.advice.trim() && item.advice.length <= 600
    const dimension = STYLE_DIMENSIONS.includes(item?.dimension) ? item.dimension as StyleDimension : undefined
    if (indexed || item?.evidence_ids !== undefined) {
      // Source POV is not permission to change the author's POV; manual guides remain editable.
      valid = valid && !!dimension && !/第[一二三]人称/.test(item.advice) && Array.isArray(item.evidence_ids) && item.evidence_ids.length >= 1 && item.evidence_ids.length <= 6
      if (valid) for (const id of [...new Set<string>(item.evidence_ids)]) {
        const source = catalog.get(id)
        if (!source) { valid = false; break }
        evidence.push({sample_id: source.sample_id, quote: source.quote})
      }
    } else {
      valid = valid && (item.dimension === undefined || !!dimension) && grounded(item) &&
        (item.evidence === undefined || (Array.isArray(item.evidence) && item.evidence.length >= 1 && item.evidence.length <= 6 && item.evidence.every(grounded)))
      if (valid) {
        evidence = item.evidence || [{sample_id: item.sample_id, quote: item.quote.trim()}]
        valid = evidence[0].sample_id === item.sample_id && evidence[0].quote === item.quote.trim()
      }
    }
    if (!valid || !evidence.length) {
      if (onInvalid) { onInvalid(); return [] }
      throw new Error('文风依据无法在取样原文中定位，原指南未改动，请重试')
    }
    const kind = STYLE_KINDS.includes(item.kind) ? item.kind : dimension === '对话语气' ? '对话' : dimension === '动作描写' ? '动作' : dimension === '叙述语气' ? '通用' : '描写'
    return [{advice: item.advice.trim(), ...evidence[0], kind, ...(dimension ? {dimension} : {}), ...(dimension || item.evidence ? {evidence} : {})}]
  })
  if (!observations.length) throw new Error(parsed.observations.length ? '本次建议均未通过核对（写法范围或原文依据），原指南保持不变。请重新提取或更换文风分析模型' : '样本不足以提取有依据的写法，请补充范文；原指南未改动')
  return {version: 1, samples, observations}
}

export function validateStyleProfile(value: any): StyleProfile | null {
  if (value === null) return null
  if (value?.version !== 1 || !Array.isArray(value.samples) || value.samples.length > 24 ||
    !Array.isArray(value.observations) || value.observations.length > 16) throw new Error('文风档案格式无效')
  const ids = new Set<string>()
  const samples = value.samples.map((s: any) => {
    if (typeof s?.id !== 'string' || !s.id || s.id.length > 50 || ids.has(s.id) || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 1200 ||
      !Number.isSafeInteger(s.source) || s.source < (s.manual ? 0 : 1) || !Number.isSafeInteger(s.start) || s.start < 0 || typeof s.enabled !== 'boolean' ||
      (s.manual !== undefined && typeof s.manual !== 'boolean') || (s.preferred !== undefined && typeof s.preferred !== 'boolean')) throw new Error('参考片段格式无效，请检查内容是否为空或超过1200字符')
    ids.add(s.id); return {id: s.id, text: s.text, source: s.source, start: s.start, enabled: s.enabled, ...(s.manual !== undefined ? {manual: s.manual} : {}), ...(s.preferred !== undefined ? {preferred: s.preferred} : {})}
  })
  if (samples.filter((s: StyleSample) => s.manual).length > 12 || samples.filter((s: StyleSample) => !s.manual).length > 12) throw new Error('自动与手动范文各最多保留12段')
  return value.observations.length ? parseStyleAnalysis(JSON.stringify({observations: value.observations}), samples) : {version: 1, samples, observations: []}
}

export function readStyleProfile(db: any, novelId: number, legacyReference?: string): StyleProfile | null {
  const row = db.prepare('SELECT content FROM novel_docs WHERE novel_id=? AND doc_type=?').get(novelId, STYLE_DOC)
  let profile: StyleProfile | null = null
  try { profile = row ? validateStyleProfile(JSON.parse(row.content)) : null } catch { /* Retain legacy references even if a profile is invalid. */ }
  const legacy = legacyReference ?? db.prepare('SELECT style_reference FROM novels WHERE id=?').get(novelId)?.style_reference
  if (legacy?.trim()) {
    profile = profile || {version: 1, samples: [], observations: []}
    const index = profile.samples.findIndex(s => s.id === LEGACY_STYLE_SAMPLE)
    const sample: StyleSample = {id: LEGACY_STYLE_SAMPLE, source: 0, start: 0, text: legacy, enabled: true, manual: true, preferred: true}
    if (index >= 0) profile.samples[index] = {...profile.samples[index], text: legacy}
    else profile.samples.unshift(sample)
  }
  return profile
}

export function styleRevision(db: any, novel: any) {
  const row = db.prepare('SELECT content FROM novel_docs WHERE novel_id=? AND doc_type=?').get(novel.id, STYLE_DOC)
  return createHash('sha256').update(JSON.stringify([novel.style_guide || '', novel.style_reference || '', row?.content || ''])).digest('hex')
}

export function renderStyleGuide(profile: StyleProfile) {
  const sections = STYLE_DIMENSIONS.flatMap(dimension => {
    const items = profile.observations.filter(o => o.dimension === dimension)
    return items.length ? [`【${dimension}】\n` + items.map(o => `- ${o.advice}`).join('\n')] : []
  })
  const legacy = profile.observations.filter(o => !o.dimension).map(o => `- ${o.advice}`).join('\n')
  return [...sections, ...(legacy ? [legacy] : [])].join('\n\n')
}

/** ponytail: a small tagged sample bank, not semantic retrieval; add indexing only for a much larger library. */
export function selectStyleSamples(db: any, novel: any, query: string) {
  const references: {id: string; text: string; kind: string}[] = []
  const profile = readStyleProfile(db, novel.id, novel.style_reference || '')
  if (!profile) return references
  const wanted: StyleKind[] = []
  if (/对话|对白|交谈|商谈|交涉|说服|质问|争执|谈判/.test(query)) wanted.push('对话')
  if (/打斗|战斗|追逐|追赶|袭击|搏斗|交火|逃跑/.test(query)) wanted.push('动作')
  if (/心理|内心|回忆|反思|情绪/.test(query)) wanted.push('心理')
  if (/描写|环境|景色|外貌|氛围/.test(query)) wanted.push('描写')
  const ranked = profile.samples.filter(s => s.enabled).map(sample => {
    const kinds = [...new Set(profile.observations.filter(o => o.sample_id === sample.id || o.evidence?.some(e => e.sample_id === sample.id)).map(o => o.kind))]
    return {...sample, kinds, score: kinds.filter(k => wanted.includes(k)).length * 2 + (kinds.length ? 1 : 0)}
  }).sort((a, b) => Number(!!b.preferred) - Number(!!a.preferred) || (a.preferred ? 0 : b.score - a.score))
  let left = 2000 - references.reduce((n, r) => n + Array.from(r.text).length, 0)
  for (const sample of ranked) {
    if (references.length >= 2 || left < 100) break
    let text = Array.from(sample.text).slice(0, Math.min(1000, left)).join('')
    if (text.length < sample.text.length) {
      const boundary = Math.max(...['。', '！', '？', '\n'].map(mark => text.lastIndexOf(mark)))
      if (boundary > text.length / 2) text = text.slice(0, boundary + 1)
    }
    if (references.some(r => r.text.includes(text) || text.includes(r.text))) continue
    references.push({id: sample.id, text, kind: sample.manual ? '作者指定' : sample.kinds.join('、') || '通用'}); left -= Array.from(text).length
  }
  return references
}
