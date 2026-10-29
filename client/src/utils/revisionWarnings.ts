type RevisionScope = { before: string; selected: string; after: string; replacement: string; instruction: string }
const compact = (text: string) => text.replace(/\s/gu, '')

/** Heuristics flag suspicious output for review; they do not prove a semantic error. */
export function revisionWarnings({ before, selected, after, replacement, instruction }: RevisionScope): string[] {
  const original = compact(selected), result = compact(replacement)
  const oldCount = Array.from(original).length, newCount = Array.from(result).length
  const warnings: string[] = []
  if (/精简|缩短|压缩|删减/.test(instruction) && newCount > oldCount) {
    warnings.push(`要求精简，但替换文字从 ${oldCount} 字增加到 ${newCount} 字，请核对是否偏离要求。`)
  } else if (!/扩写|展开|补充|增加/.test(instruction) && newCount > Math.max(oldCount * 3, oldCount + 120)) {
    warnings.push(`替换文字从 ${oldCount} 字增加到 ${newCount} 字，可能超出选区范围。`)
  }
  const neighbors = [compact(before), compact(after)]
  // Compare substantial clauses rather than names or short dialogue to limit false alarms.
  const repeated = replacement.split(/[。！？\n]/u).map(compact).find(part =>
    Array.from(part).length >= 12 && !original.includes(part) && neighbors.some(text => text.includes(part)))
  if (repeated) warnings.push(`疑似重复选区外原文：“${Array.from(repeated).slice(0, 50).join('')}${Array.from(repeated).length > 50 ? '…' : ''}”。前后文会保留，请先删除重复部分。`)
  return warnings
}
