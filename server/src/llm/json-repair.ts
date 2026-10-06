/**
 * LLM 输出 JSON 的修复。
 *
 * 中文场景下最高频的失效：模型想在字符串里引用原文，顺手用了英文双引号且没转义，
 *   "summary": "老赵"起初拒绝"这一节拍被压缩掉"
 * JSON.parse 直接报错，整次调用白跑。
 *
 * prompt 里已经要求改用「」，但模型不会百分百遵守，这里做兜底。
 * 判据：字符串内部遇到 `"` 时，看它后面第一个非空白字符——
 * 是 , } ] : 之一才可能是真正的结束引号，否则就是该被转义的内部引号。
 */
export function repairInnerQuotes(json: string): string {
  let out = ''
  let inString = false

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]

    if (inString && ch === '\\') {
      out += ch + (json[i + 1] ?? '')
      i++
      continue
    }

    if (ch === '"') {
      if (!inString) {
        inString = true
        out += ch
        continue
      }
      let j = i + 1
      while (j < json.length && /\s/.test(json[j])) j++
      const next = json[j]
      if (next === ',' || next === '}' || next === ']' || next === ':' || next === undefined) {
        inString = false
        out += ch
      } else {
        out += '\\"'
      }
      continue
    }

    out += ch
  }

  return out
}

/**
 * 按容错程度递进地解析：原样 → 抠出最外层括号 → 修复内部引号。
 * 全都失败返回 null，由调用方决定怎么降级。
 */
export function parseLooseJSON<T = any>(text: string, open: '{' | '[' = '{'): T | null {
  const close = open === '{' ? '}' : ']'

  const tryParse = (s: string): T | null => {
    try {
      return JSON.parse(s) as T
    } catch {
      return null
    }
  }

  const trimmed = text.trim()
  const direct = tryParse(trimmed)
  if (direct !== null) return direct

  const start = trimmed.indexOf(open)
  const end = trimmed.lastIndexOf(close)
  const sliced = start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed

  const fromSlice = tryParse(sliced)
  if (fromSlice !== null) return fromSlice

  return tryParse(repairInnerQuotes(sliced))
}
