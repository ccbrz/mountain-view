/**
 * 补丁式修订：模型只输出「查找—替换」，由这里校验后应用到原稿。
 *
 * 为什么不让模型直接重写全文：
 * 整章重写时模型必然会顺手改动没被点名的地方，把作者满意的部分也改掉，
 * 而且 5000 字重吐一遍还会引入新的 AI 腔。补丁方式下，没被 find 命中的
 * 文字在物理上不可能变动——这个保证来自机制，不来自 prompt 里的叮嘱。
 *
 * 代价是依赖模型逐字引用原文的能力。所以每条补丁都要过唯一性校验，
 * 对不上就跳过并如实报告，绝不模糊匹配——改不动好过改错。
 */

import { LLMConfig } from './config'
import { invokeWithRetry, InvokeContext } from './invoke'
import * as P from './prompts'
import { parseLooseJSON } from './json-repair'

export interface Patch {
  note: string
  find: string
  replace: string
}

export type PatchFailReason = '原文未找到' | '原文出现多次，无法定位' | '模型声明无法用补丁表达'

export interface PatchOutcome {
  patch: Patch
  reason: PatchFailReason
}

export interface ReviseResult {
  content: string
  applied: Patch[]
  failed: PatchOutcome[]
  /** 净增减字数，负数代表压缩 */
  wordDelta: number
  raw?: string
}

/** 修订不需要创造力，降温执行。起草那档温度会让它自由发挥。 */
const REVISE_TEMPERATURE = 0.3

function parsePatches(text: string): { patches: Patch[]; raw?: string } {
  const arr = parseLooseJSON<any[]>(text, '[')
  if (Array.isArray(arr)) {
    return {
      patches: arr.map((p: any) => ({
        note: String(p?.note || ''),
        find: String(p?.find ?? ''),
        replace: String(p?.replace ?? ''),
      })),
    }
  }
  return { patches: [], raw: text }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

const countWords = (s: string) => s.replace(/\s/g, '').length

/**
 * 逐条应用补丁。每条都在「当前文本」上重新校验唯一性，
 * 因为前面的补丁可能已经改变了后面补丁的上下文。
 */
export function applyPatches(original: string, patches: Patch[]): ReviseResult {
  let content = original
  const applied: Patch[] = []
  const failed: PatchOutcome[] = []

  for (const patch of patches) {
    if (!patch.find) {
      failed.push({ patch, reason: '模型声明无法用补丁表达' })
      continue
    }
    const hits = countOccurrences(content, patch.find)
    if (hits === 0) {
      failed.push({ patch, reason: '原文未找到' })
      continue
    }
    if (hits > 1) {
      failed.push({ patch, reason: '原文出现多次，无法定位' })
      continue
    }
    // 用函数形式，避免 replace 里的 $&、$$ 被当成替换模板
    content = content.replace(patch.find, () => patch.replace)
    applied.push(patch)
  }

  return {
    content,
    applied,
    failed,
    wordDelta: countWords(content) - countWords(original),
  }
}

export async function revisePatchwise(
  config: LLMConfig,
  params: {
    content: string
    outline: string
    acceptedNotes: string[]
    rejectedNotes: string[]
    styleGuide?: string
  },
  ctx: InvokeContext,
): Promise<ReviseResult> {
  const text = await invokeWithRetry(
    { ...config, temperature: REVISE_TEMPERATURE },
    P.patchReviseSystemPrompt(params.styleGuide || ''),
    P.USER_PATCH_REVISE(params),
    3,
    ctx,
  )

  const { patches, raw } = parsePatches(text)
  if (raw) {
    return { content: params.content, applied: [], failed: [], wordDelta: 0, raw }
  }
  return applyPatches(params.content, patches)
}
