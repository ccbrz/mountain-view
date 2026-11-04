/**
 * NovelAI ends any single response after ~110 s, which is shorter than a 4000–5000 字 chapter at GLM speed.
 * Generation therefore runs in segments: the server keeps continuing until the model finishes on its own,
 * then checks the script and continues once more for any trailing events that were never reached.
 */
import { parseLooseJSON } from './json-repair'

export const MAX_SEGMENTS = 4

const SENTENCE_END = /[。！？!?…”」』）)\n]\s*$/u

export const endsMidSentence = (text: string) => !!text.trim() && !SENTENCE_END.test(text)

/** A cut usually lands mid-sentence; joining with a paragraph break would split that sentence in two. */
export function joinSegments(previous: string, next: string) {
  const addition = next.replace(/^\s+/u, '')
  if (!previous.trim()) return addition
  return endsMidSentence(previous)
    ? previous.replace(/\s+$/u, '') + addition
    : previous.replace(/\s+$/u, '') + '\n\n' + addition
}

export const COVERAGE_SYSTEM = `你是小说台本核对员。对照编号台本与正文，判断每个事件是否已经在正文中写到。只做核对，不评价文笔，不写正文。
写到 = 正文实际呈现了该事件的发生或结果；只在对白或回忆里一笔带过、但台本要求正面呈现的，算未写到。
另外判断正文在写完台本最后一个事件、到达落点之后，是否还继续写了台本没有的新事件（如新的行程、新线索、新冲突）。
只输出 JSON：{"last_written": 正文中写到的最后一个事件编号（一个都没有写 0）, "missing": [未写到的事件编号], "beyond_end": true 或 false}。不输出其他内容。`

export const coverageInput = (beats: string[], content: string) =>
  `【编号台本】\n${beats.map((beat, i) => `${i + 1}. ${beat}`).join('\n')}\n\n【正文】\n${content}`

export interface Coverage {
  last_written: number
  /** Events after the last written one: the chapter stopped before reaching them. */
  trailing: number[]
  /** Events skipped in the middle; appending cannot fix these, so the author is told instead. */
  skipped: number[]
  /** The prose kept going with events the script does not have after its last event. */
  beyond_end: boolean
}

export function parseCoverage(raw: string, beatCount: number): Coverage | null {
  const data = parseLooseJSON<any>(raw, '{')
  const last = Number(data?.last_written)
  if (!Number.isInteger(last) || last < 0 || last > beatCount || !Array.isArray(data.missing)) return null
  const missing = [...new Set<number>(data.missing.map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= beatCount)
    .sort((a, b) => a - b)
  const trailing = Array.from({ length: beatCount - last }, (_, i) => last + i + 1)
  const skipped = missing.filter(n => n <= last)
  // A chapter that reached its last event but skipped most of the way is a contradictory answer, not a finding.
  if (skipped.length > beatCount / 2) return null
  return { last_written: last, trailing, skipped, beyond_end: data.beyond_end === true }
}

/** Models sometimes sign off with bookkeeping such as 「[字数统计：5479]」 or 「（本章完）」; that is not prose. */
const MARKER =
  /\n?[ \t]*[\[【（(〔]?[ \t]*(?:字数(?:统计)?[:：]?[ \t]*\d+[^\n]*|全文约?[ \t]*\d+[ \t]*字[^\n]*|(?:第[一二三四五六七八九十百千\d]+章[ \t]*)?(?:完|终)|本章完|全文完)[ \t]*[\]】）)〕]?[ \t]*$/u
export function stripProseMarkers(text: string) {
  let out = text.replace(/\s+$/u, '')
  for (
    let next = out.replace(MARKER, '').replace(/\s+$/u, '');
    next !== out;
    next = out.replace(MARKER, '').replace(/\s+$/u, '')
  )
    out = next
  return out
}
