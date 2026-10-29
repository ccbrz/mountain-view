import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Collapse, ConfigProvider, Drawer, Dropdown, Empty, Input, InputNumber, Modal, Popconfirm, Select, Spin, Switch, Tabs, Tag, Tooltip, message, theme } from 'antd'
import { BookOutlined, CloseOutlined, EditOutlined, FileTextOutlined, HistoryOutlined, PlusOutlined, SaveOutlined, SendOutlined, UndoOutlined, EyeOutlined, DeleteOutlined, LoadingOutlined, BulbOutlined, ExpandOutlined, UploadOutlined, DownloadOutlined, ArrowLeftOutlined, SettingOutlined, BugOutlined, SkinOutlined, MoreOutlined, CheckCircleOutlined } from '@ant-design/icons'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import './WritingDesk.css'
import { revisionWarnings } from '../utils/revisionWarnings'
import type { ReviewIssue, ReviewResult } from './ReviewPanel'

interface LoreEntry { id: string; title: string; text: string; keys: string[]; enabled: boolean; always_on: boolean; category: string }
interface Settings { memory_through_chapter?: number; context_tokens: number; model_id: string; memory: string; system_prompt: string; lorebook: LoreEntry[]; temperature: number; max_output_tokens: number; recent_context_chars: number }
interface ModelProfile { id: string; name: string; provider: string; model: string; base_url: string; context_tokens: number; has_api_key?: boolean }
interface StoryContext {
  model?: ModelProfile
  system_prompt: string; user_prompt: string; chars: number; warnings: string[]
  blocks: { label: string; text: string }[]; active_lore: string[]; recent_sources: number[]
  budget?: { method: string; estimated_input_tokens: number; output_tokens: number; reserved_tokens: number; context_tokens: number; remaining_tokens: number; blocked: boolean; trimmed: {label: string; removed_chars: number}[] }
  lore_status?: { matched_source?: string; id: string; title: string; included: boolean; reason: string; matched_key?: string; chars: number }[]
}
interface Chapter { incomplete?: boolean; id?: number; status?: string; raw_script: string; title: string; content: string; author_note: string; last_context: StoryContext | null }
interface ChapterItem { id?: number; index_status?: string; chapter_idx: number; title: string; has_content: boolean; status?: string }
interface MemoryVersion { id: number; chapter_number: number | null; title: string; kind: string; created_by: string; created_at: string; memory?: string; memory_through_chapter?: number | null; restorable?: boolean; restore_reason?: string; context_revision?: number }
const memoryVersionLabels: Record<string, string> = {save: '保存 Memory', finalize: '章节定稿', legacy: '旧版进度存档', migration: '迁移时的 Memory', backup: '恢复或修改前备份', restore: '恢复记忆'}
interface Project { length_range: { min: number; max: number }; writing_template: string; settings: Settings; chapters: ChapterItem[] }
interface Selection { chapter_idx: number; before: string; selected: string; after: string }
interface Revision extends Selection { instruction: string; replacement: string; context: StoryContext }
interface Preparation { facts: {source: string; quote: string; note: string}[]; style_rules: {quote: string; rule: string}[]; conflicts: {source: string; quote: string; plan_quote: string; problem: string}[] }
interface PreparationView { preparation_warning?: string; artifact_id: string; preparation: Preparation; context: StoryContext; source: string; chapter_idx: number }
interface CheckView { artifact_id: string; review: ReviewResult; context: StoryContext; source: string; chapter_idx: number; length: {chars: number; min: number; max: number; status: string} }
interface RepairView { artifact_id: string; diagnosis?: ReviewResult; author_decisions?: ReviewIssue[]; blocked?: {patch: {note: string; find: string; replace: string}; reason: string}[]; audit?: {warning?: string}; length?: {before: number; chars: number; min: number; max: number; status: string}; contexts?: {diagnosis?: StoryContext; revision?: StoryContext; audit?: StoryContext}; content: string; applied: {note: string; find: string; replace: string}[]; failed: {reason: string}[]; context: StoryContext; source: string }
interface HistoryItem { id: string; kind: 'write' | 'continue' | 'revise' | 'memory' | 'prepare' | 'check' | 'repair' | 'refine'; created_at: string; chapter_idx: number }
interface Artifact extends HistoryItem { incomplete?: boolean; content?: string; replacement?: string; memory?: string; preparation?: Preparation; review?: ReviewResult; context: StoryContext; source: Chapter & { settings: Settings; before?: string; after?: string; selected?: string } }
interface LocalDraft { chapter_idx: number; chapter: Chapter; base_chapter: Chapter; settings: Settings; base_settings: Settings; saved_at: string }
const historyLabels = { write: '整章生成', continue: '继续写', revise: '选段修改', memory: '记忆建议', prepare: '写前核对', check: '写后核对', repair: '局部修订建议', refine: '全文精修' }
const emptyChapter: Chapter = { incomplete: false, raw_script: '', title: '', content: '', author_note: '', last_context: null }
const proseLength = (text: string) => Array.from(text.replace(/\s/gu, '')).length
const proseCountHint = '仅统计正文，含标点、不含空格和换行；不计台本、批注和设定。'
const chapterText = ({ raw_script, title, content, author_note, incomplete }: Chapter) => JSON.stringify({ raw_script, title, content, author_note, incomplete: !!incomplete })

export default function WritingDesk({ novelId, novelTitle, refreshVersion, canReindex, onBack, onOpenTool, onDebug, onOutlineReview, onOutlineVersions, modelsVersion }: {
  novelId: string; novelTitle: string; modelsVersion: string; refreshVersion: number; canReindex: boolean;
  onBack: () => void; onOpenTool: (key: string) => void; onDebug: () => void;
  onOutlineReview: (num: number) => void; onOutlineVersions: (num: number) => void;
}) {
  const { user } = useAuth()
  const draftKey = `mountain-view-writing-draft-v1:${user?.username}:${novelId}`
  const themeKey = `mountain-view-writing-theme-v1:${user?.username}`
  const [visualTheme, setVisualTheme] = useState<'dark' | 'dragon'>(() => {
    try { return localStorage.getItem(themeKey) === 'dark' ? 'dark' : 'dragon' } catch { return 'dragon' }
  })
  async function deskApi<T>(path: string, body?: object): Promise<T> {
    try {
      const result = body ? await api.post(`/novels/${novelId}/writer${path}`, body) : await api.get(`/novels/${novelId}/writer${path}`)
      return result.data as T
    } catch (error: any) { throw new Error(error.response?.data?.message || error.message || '操作失败，编辑仍保留在页面中') }
  }
  const [notice, noticeHolder] = message.useMessage()
  const [modal, modalHolder] = Modal.useModal()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [writingTemplate, setWritingTemplate] = useState('')
  const [lengthRange, setLengthRange] = useState<{ min: number; max: number } | null>(null)
  const [baseSettings, setBaseSettings] = useState<Settings | null>(null)
  const [chapters, setChapters] = useState<ChapterItem[]>([])
  const [models, setModels] = useState<ModelProfile[]>([])
  const [recovery, setRecovery] = useState<LocalDraft | null>(null)
  const [draftError, setDraftError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [chapterIdx, setChapterIdx] = useState(1)
  const [chapter, setChapter] = useState<Chapter>(emptyChapter)
  const [baseChapter, setBaseChapter] = useState<Chapter>(emptyChapter)
  const [busy, setBusy] = useState('正在打开写作台')
  const [chapterSaving, setChapterSaving] = useState(false)
  const [chapterSaveError, setChapterSaveError] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [inspectorTab, setInspectorTab] = useState('writing')
  const [loreCategory, setLoreCategory] = useState<string | undefined>()
  const [memoryHistoryOpen, setMemoryHistoryOpen] = useState(false)
  const [memoryVersions, setMemoryVersions] = useState<MemoryVersion[]>([])
  const [memoryVersion, setMemoryVersion] = useState<MemoryVersion | null>(null)
  const [memoryRestore, setMemoryRestore] = useState<{id: number | null; memory?: string; memory_through_chapter?: number; restorable: boolean; restore_reason?: string; empty_opening?: boolean; target_chapter?: number; context_revision: number; settings: Settings; base_settings: Settings} | null>(null)
  const [renaming, setRenaming] = useState<{idx: number; base: Chapter; title: string} | null>(null)
  const [loreEdit, setLoreEdit] = useState<LoreEntry | null>(null)
  const [lorePolish, setLorePolish] = useState<{ source: LoreEntry; text: string; model: string } | null>(null)
  const [expanded, setExpanded] = useState<'memory' | 'author_note' | null>(null)
  const [importedLore, setImportedLore] = useState<LoreEntry[] | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [instruction, setInstruction] = useState('')
  const [revision, setRevision] = useState<Revision | null>(null)
  const [revisionAcknowledged, setRevisionAcknowledged] = useState(false)
  const [preparation, setPreparation] = useState<PreparationView | null>(null)
  const [quality, setQuality] = useState<CheckView | null>(null)
  const [repair, setRepair] = useState<RepairView | null>(null)
  const revisionIssues = revision ? revisionWarnings(revision) : []
  const [memoryDraft, setMemoryDraft] = useState<{ original: string; proposed: string; content: string; chapter_idx: number; finalize?: { base_chapter: Chapter; base_settings: Settings } } | null>(null)
  const [contextView, setContextView] = useState<{ title: string; context: StoryContext; preview_mode?: 'write' | 'continue' } | null>(null)
  const [undo, setUndo] = useState<{content: string; incomplete?: boolean}[]>([])
  const [mobilePanel, setMobilePanel] = useState<'chapters' | 'settings' | null>(null)
  const [mode, setMode] = useState<'write' | 'continue'>('write')
  const editor = useRef<HTMLTextAreaElement>(null)
  const operation = useRef(0)
  const savingChapter = useRef<Promise<boolean> | null>(null)
  const chapterDirty = chapterText(chapter) !== chapterText(baseChapter)
  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(baseSettings)
  const locked = Boolean(busy) || chapterSaving
  const dirty = chapterDirty || settingsDirty
  const proseChars = proseLength(chapter.content)
  const proseCount = proseChars.toLocaleString()
  const lengthWarning = !lengthRange || !proseChars ? '' : proseChars < lengthRange.min ? `正文 ${proseCount} 字，低于目标 ${lengthRange.min}–${lengthRange.max} 字，还差至少 ${lengthRange.min - proseChars} 字。` : proseChars > lengthRange.max ? `正文 ${proseCount} 字，超出目标 ${lengthRange.min}–${lengthRange.max} 字，超出 ${proseChars - lengthRange.max} 字。` : ''

  async function openProject(preferredChapter?: number) {
    const version = ++operation.current
    setBusy('正在打开写作台'); setError('')
    try {
      const project = await deskApi<Project>('/project')
      const modelData = await deskApi<{ models: ModelProfile[] }>('/models')
      let draft: LocalDraft | null = null
      try {
        const value = preferredChapter === undefined ? JSON.parse(localStorage.getItem(draftKey) || 'null') : null
        if (value && Number.isInteger(value.chapter_idx) && value.chapter_idx > 0 && value.chapter_idx <= 999999 && typeof value.chapter?.content === 'string' && typeof value.chapter.raw_script === 'string' && value.settings && value.base_settings && value.base_chapter) draft = value
      } catch { setDraftError('浏览器草稿无法读取，请检查浏览器存储权限。服务器生成记录仍可在历史中找回。') }
      const idx = draft?.chapter_idx ?? (project.chapters.some(item => item.chapter_idx === preferredChapter) ? preferredChapter! : project.chapters[0]?.chapter_idx ?? 1)
      const loaded = await deskApi<Chapter>(`/chapter/${idx}`)
      if (version !== operation.current) return
      setLengthRange(project.length_range); setWritingTemplate(project.writing_template); setSettings(project.settings); setBaseSettings(project.settings); setModels(modelData.models); setRecovery(draft)
      setChapters(project.chapters.some(item => item.chapter_idx === idx) ? project.chapters : [...project.chapters, { chapter_idx: idx, title: loaded.title, has_content: Boolean(loaded.content) }]); setChapterIdx(idx); setChapter(loaded); setBaseChapter(loaded)
      setSelection(null); setUndo([])
      setChapterSaveError('')
    } catch (e) { setError(e instanceof Error ? e.message : '打开失败，请重试。') }
    finally { if (version === operation.current) setBusy('') }
  }

  useEffect(() => { void deskApi<{ models: ModelProfile[] }>('/models').then(data => setModels(data.models)).catch(report) }, [modelsVersion])
  useEffect(() => { void openProject(); return () => { operation.current += 1 } }, [])
  useEffect(() => {
    if (!refreshVersion) return
    if (dirty || locked || recovery) { setError('服务器中的作品已更新，当前编辑已保留。请刷新页面后选择恢复草稿或使用服务器版本。'); return }
    void openProject(chapterIdx)
  }, [refreshVersion])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  useEffect(() => {
    if (!settings || !baseSettings || locked || recovery) return
    try {
      if (dirty) localStorage.setItem(draftKey, JSON.stringify({ chapter_idx: chapterIdx, chapter, base_chapter: baseChapter, settings, base_settings: baseSettings, saved_at: new Date().toISOString() }))
      else localStorage.removeItem(draftKey)
    } catch { setDraftError('浏览器无法备份当前编辑，请确认正文自动保存成功、项目设置已保存后再离开。AI 生成记录仍会保存在服务器。') }
  }, [chapter, baseChapter, settings, baseSettings, chapterIdx, dirty, locked, recovery])

  useEffect(() => {
    if (!chapterDirty || locked || recovery || chapterSaveError || !settings) return
    const timer = window.setTimeout(() => { void saveChapter() }, 3000)
    return () => window.clearTimeout(timer)
  }, [chapter, baseChapter, chapterIdx, chapterDirty, locked, recovery, chapterSaveError, settings])

  function report(e: unknown) { setError(e instanceof Error ? e.message : '操作未完成，你的编辑仍保留在这里。') }
  function editChapter(values: Partial<Chapter>) { setChapter(current => ({ ...current, ...values })) }
  function editSettings(values: Partial<Settings>) { setSettings(current => current ? { ...current, ...values } : current) }
  function requestBody(nextMode = mode) {
    return { incomplete: !!chapter.incomplete, chapter_idx: chapterIdx, raw_script: chapter.raw_script, title: chapter.title, author_note: chapter.author_note, content: chapter.content, settings, mode: nextMode }
  }
  async function run(label: string, work: () => Promise<void>) {
    if (locked) return
    setBusy(label); setError('')
    try { await work(); return true } catch (e) { report(e); return false } finally { setBusy('') }
  }
  async function loadChapter(idx: number) {
    if (locked) return false
    if (idx === chapterIdx) return true
    const load = () => run('正在打开章节', async () => {
      const loaded = await deskApi<Chapter>(`/chapter/${idx}`)
      setChapterIdx(idx); setChapter(loaded); setBaseChapter(loaded); setChapterSaveError(''); setSelection(null); setUndo([]); setInstruction(''); setMode('write')
      setChapters(list => list.some(item => item.chapter_idx === idx) ? list : [...list, { chapter_idx: idx, title: loaded.title || `第 ${idx} 章`, has_content: Boolean(loaded.content) }].sort((a, b) => a.chapter_idx - b.chapter_idx))
    })
    if (chapterDirty && !await saveChapter()) return false
    return await load()
  }
  async function persistSettings(next: Settings) {
    const saved = await deskApi<{ settings: Settings }>('/settings', { settings: next, base_settings: baseSettings, chapter_idx: chapterIdx })
    setSettings(saved.settings); setBaseSettings(saved.settings)
  }
  async function saveChapter(next = chapter) {
    if (savingChapter.current) return savingChapter.current
    if (chapterText(next) === chapterText(baseChapter)) return true
    const version = operation.current, idx = chapterIdx, base = baseChapter
    setChapterSaving(true); setChapterSaveError('')
    const pending = (async () => {
      try {
        const saved = await deskApi<Chapter>('/save', { incomplete: !!next.incomplete, chapter_idx: idx, raw_script: next.raw_script, title: next.title, content: next.content, author_note: next.author_note, base_content: base.content, base_chapter: base, last_context: next.last_context })
        if (version !== operation.current) return false
        // A late response must never replace edits made after this snapshot was sent.
        setChapter(current => chapterText(current) === chapterText(next) ? saved : {...current, id: saved.id, status: saved.status})
        setBaseChapter(saved)
        setChapters(list => list.map(item => item.chapter_idx === idx ? { ...item, id: saved.id, title: saved.title, status: saved.status, has_content: Boolean(saved.content.trim()) } : item))
        return true
      } catch (e) {
        if (version === operation.current) setChapterSaveError(e instanceof Error ? e.message : '正文自动保存失败，请重试')
        return false
      } finally {
        savingChapter.current = null
        if (version === operation.current) setChapterSaving(false)
      }
    })()
    savingChapter.current = pending
    return pending
  }
  async function saveSettings() {
    if (!settings) return
    return run('正在保存项目设置', async () => {
      if (settingsDirty) await persistSettings(settings)
      notice.success('项目设置已保存；正文独立自动保存')
    })
  }
  async function saveAll() {
    if (!settings) return
    return run('正在保存', async () => {
      if (settingsDirty) await persistSettings(settings)
      if (!await saveChapter()) throw new Error('本章未保存成功，请重试或处理版本冲突后再离开')
    })
  }
  async function openTool(action: () => void | Promise<void>) {
    if (locked || recovery) return
    if (!dirty || await saveAll()) { setMobilePanel(null); await action() }
  }
  async function backToLibrary() {
    if (locked || recovery) return
    if (settingsDirty) modal.confirm({ title: '保存项目设置后返回书架？', content: '项目设置尚未保存，离开前也会完成正文自动保存。', okText: '保存并返回', cancelText: '继续写作', onOk: async () => { if (await saveAll()) onBack(); else throw new Error('保存失败，请留在写作台重试') } })
    else if (await saveChapter()) onBack()
  }
  async function generate(nextMode: 'write' | 'continue') {
    if (!chapter.raw_script.trim()) { notice.warning('请先填写本章台本'); return }
    if (settings?.memory.trim() && (settings.memory_through_chapter === undefined || (nextMode === 'write' ? settings.memory_through_chapter >= chapterIdx : settings.memory_through_chapter > chapterIdx))) { await previewMemoryRestore(); return }
    const generateNow = () => run(nextMode === 'write' ? '正在将台本写成正文' : '正在继续写', async () => {
      setMode(nextMode); setQuality(null); setRepair(null)
      setBusy('正在核对本章起点、事实与文风')
      const source = requestBody(nextMode)
      const prepared = await deskApi<PreparationView>('/prepare', source)
      setPreparation({...prepared, chapter_idx: chapterIdx, source: JSON.stringify(source)})
      setChapter(current => ({...current, last_context: prepared.context}))
      if (prepared.preparation.conflicts.length) { setError('写前发现材料冲突，请先按下方原句核对 Memory、台本或设定，再生成。正文和 Memory 均未修改。'); return }
      setBusy('正在按台本生成正文')
      const result = await deskApi<{ content: string; context: StoryContext; incomplete: boolean }>('/generate', {...source, prepared_id: prepared.artifact_id})
      const next = {...chapter, content: result.content, last_context: result.context, incomplete: result.incomplete}
      setUndo(history => [...history.slice(-29), {content: chapter.content, incomplete: chapter.incomplete}]); setChapter(next); setSelection(null); setMode(nextMode)
      const saved = await saveChapter(next)
      if (result.incomplete) notice.warning('达到单次输出上限，已保留未完成草稿，请继续写或手工补全')
      else if (saved) {
        try { await refineProse(next, nextMode) } catch (e) { setError(`正文已生成并自动保存，共 ${proseLength(result.content).toLocaleString()} 字；自动精修未完成，可点击「全文精修」重试：${e instanceof Error ? e.message : '请重试'}`) }
      }
    })
    if (nextMode === 'write' && chapter.content.trim()) modal.confirm({ title: '重新生成本章草稿？', content: '新正文生成后会自动保存。原有已保存正文保留修订记录，也可以用“撤销 AI 修改”恢复编辑前的内容。', okText: '生成新草稿', cancelText: '取消', onOk: generateNow })
    else await generateNow()
  }
  async function refineProse(next = chapter, nextMode = mode) {
    setBusy('正在全文精修：三层诊断 → 定点改稿 → 候选复核')
    const source = {...requestBody(nextMode), content: next.content, incomplete: !!next.incomplete,
      title: next.title, raw_script: next.raw_script, author_note: next.author_note}
    const result = await deskApi<RepairView>('/refine', source)
    setRepair({...result, source: JSON.stringify(source)})
    if (result.diagnosis && result.length) setQuality({artifact_id: result.artifact_id, review: result.diagnosis,
      length: result.length, context: result.contexts?.diagnosis || result.context, chapter_idx: chapterIdx, source: JSON.stringify(source)})
    setChapter(current => current.content === next.content ? {...current, last_context: result.context} : current)
  }
  const qualityCurrent = quality?.chapter_idx === chapterIdx && quality.source === JSON.stringify(requestBody())
  async function suggestRepair() {
    await run('正在全文精修', async () => {
      if (!await saveChapter()) throw new Error('本章尚未保存成功，请重试')
      await refineProse()
    })
  }
  async function acceptRepair() {
    if (!repair || repair.source !== JSON.stringify(requestBody())) { notice.warning('正文或设定已变化，请重新进行全文精修'); return }
    const candidate = repair
    await run('正在保存已复核的修订', async () => {
      setUndo(values => [...values.slice(-29), {content: chapter.content, incomplete: chapter.incomplete}])
      const next = {...chapter, content: candidate.content, last_context: candidate.context}
      setChapter(next); setRepair(null); setSelection(null); setQuality(null)
      if (!await saveChapter(next)) throw new Error('修订留在编辑区，自动保存失败，请重试保存')
      notice.success('已采用通过候选核验的修改；仍需作者决定的问题请继续核对')
    })
  }
  async function revise() {
    if (!selection || !instruction.trim()) return
    if (selection.chapter_idx !== chapterIdx || selection.before + selection.selected + selection.after !== chapter.content) { setSelection(null); notice.warning('正文已变化，请重新选择要修改的文字'); return }
    await run('正在修改选中段落', async () => {
      const result = await deskApi<{ replacement: string; context: StoryContext }>('/revise', { ...requestBody(), ...selection, instruction })
      setRevisionAcknowledged(false); setRevision({ ...selection, ...result, instruction })
      editChapter({ last_context: result.context })
    })
  }
  function acceptRevision() {
    if (!revision || (revisionIssues.length > 0 && !revisionAcknowledged)) return
    if (revision.chapter_idx !== chapterIdx || chapter.content !== revision.before + revision.selected + revision.after) { notice.error('原文已变化，这份修改没有应用。请重新选段。'); return }
    setUndo(history => [...history.slice(-29), {content: chapter.content, incomplete: chapter.incomplete}]); editChapter({ content: revision.before + revision.replacement + revision.after, last_context: revision.context })
    setRevision(null); setSelection(null); setInstruction(''); notice.success('已替换选中段落，停止编辑 3 秒后自动保存；可撤销')
  }
  async function suggestMemory(finalize = false) {
    if (!settings) return
    if (settings.memory.trim() && (settings.memory_through_chapter === undefined || settings.memory_through_chapter >= chapterIdx)) { await previewMemoryRestore(); return }
    await run(finalize ? '正在为定稿自动整理 Memory' : '正在整理本章记忆建议', async () => {
      const result = await deskApi<{ memory: string; context: StoryContext }>('/memory/suggest', requestBody())
      setMemoryDraft({ original: settings.memory, proposed: result.memory, content: chapter.content, chapter_idx: chapterIdx, ...(finalize ? {finalize: {base_chapter: baseChapter, base_settings: baseSettings!}} : {}) }); editChapter({ last_context: result.context })
    })
  }
  async function previewMemoryRestore(version?: number) {
    if (!settings || !baseSettings) return
    await run('正在准备本章开始前的记忆', async () => {
      if (!await saveChapter()) throw new Error('本章尚未保存成功，请重试')
      const result = await deskApi<Omit<NonNullable<typeof memoryRestore>, 'settings' | 'base_settings'>>(version === undefined ? `/memory/before/${chapterIdx}` : `/memory/history/${version}`)
      setMemoryRestore({...result, settings, base_settings: baseSettings})
    })
  }
  async function restoreMemory() {
    if (!memoryRestore?.restorable) return
    await run('正在备份并恢复 Memory', async () => {
      const result = await deskApi<{settings: Settings}>('/memory/restore', {version_id: memoryRestore.id,
        target_chapter: memoryRestore.target_chapter, context_revision: memoryRestore.context_revision,
        settings: memoryRestore.settings, base_settings: memoryRestore.base_settings})
      setSettings(result.settings); setBaseSettings(result.settings); setMemoryRestore(null); setMemoryHistoryOpen(false)
      setPreparation(null); setQuality(null); setRepair(null)
      notice.success('记忆已恢复，原版本已备份；现在可以重写本章')
    })
  }
  async function showMemoryHistory() {
    await run('正在读取记忆历史', async () => {
      const result = await deskApi<{items: MemoryVersion[]}>('/memory/history')
      setMemoryVersions(result.items)
      setMemoryVersion(result.items.length ? await deskApi<MemoryVersion>(`/memory/history/${result.items[0].id}`) : null)
      setMemoryHistoryOpen(true); setMobilePanel(null)
    })
  }
  async function preview(nextMode: 'write' | 'continue' = mode) {
    await run('正在整理本次上下文', async () => {
      const context = await deskApi<StoryContext>('/context', requestBody(nextMode))
      setMode(nextMode)
      setContextView({ title: '本次上下文 · 预览', context, preview_mode: nextMode })
    })
  }
  async function showHistory() {
    await run('正在读取生成记录', async () => {
      const result = await deskApi<{ items: HistoryItem[] }>(`/chapter/${chapterIdx}/history`)
      setHistory(result.items); setArtifact(null); setHistoryOpen(true)
    })
  }
  function restoreArtifact() {
    if (!artifact || !settings) return
    if (artifact.kind === 'memory') {
      if (chapterDirty || artifact.source.content !== chapter.content || artifact.source.settings.memory !== settings.memory) { notice.warning('这份建议对应的正文或原记忆已经变化，请根据当前定稿重新整理'); return }
      setMemoryDraft({ original: settings.memory, proposed: artifact.memory || '', content: chapter.content, chapter_idx: chapterIdx })
      setHistoryOpen(false); return
    }
    const item = artifact
    const apply = () => {
      const content = item.kind === 'revise' ? (item.source.before || '') + (item.replacement || '') + (item.source.after || '') : item.content || ''
      setUndo(values => [...values.slice(-29), {content: chapter.content, incomplete: chapter.incomplete}])
      editChapter({ raw_script: item.source.raw_script, title: item.source.title, author_note: item.source.author_note, content, incomplete: item.kind === 'revise' ? !!item.source.incomplete : !!item.incomplete, last_context: item.context })
      setSelection(null); setHistoryOpen(false); notice.success('已恢复到编辑区，3 秒后自动保存')
    }
    modal.confirm({ title: '恢复这份生成草稿？', content: '会替换本章正文、台本和作者批注并自动保存。全书 Memory 和设定保持当前版本；可撤销正文修改。', okText: '恢复到编辑区', cancelText: '取消', onOk: apply })
  }
  function downloadBook(format: 'txt' | 'md' | 'json') {
    const download = async () => {
      await run('正在准备下载', async () => {
        const response = await api.get(`/novels/${novelId}/writer/download?format=${format}`, { responseType: 'blob' })
        const url = URL.createObjectURL(response.data)
        const link = document.createElement('a'); link.href = url; link.download = format === 'json' ? 'mountain-view-backup.json' : `mountain-view-full.${format}`; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
    }
    if (settingsDirty) modal.confirm({ title: '保存项目设置后下载？', content: '保存当前项目设置，并在导出前完成正文自动保存。', okText: '保存并下载', cancelText: '取消', onOk: async () => { if (await saveAll()) await download() } })
    else void saveChapter().then(saved => { if (saved) void download() })
  }
  function newLore() { setLoreEdit({ id: crypto.randomUUID(), title: '', text: '', keys: [], enabled: true, always_on: false, category: '' }) }
  function newChapter() {
    let idx = 1
    while (chapters.some(item => item.chapter_idx === idx)) idx += 1
    void loadChapter(idx)
  }
  async function chapterAction(item: ChapterItem, action: string) {
    await openTool(async () => {
      if (action === 'versions') { onOutlineVersions(item.chapter_idx); return }
      if (action === 'rename') {
        await run('正在读取章节', async () => {
          const base = await deskApi<Chapter>(`/chapter/${item.chapter_idx}`)
          setRenaming({idx: item.chapter_idx, base, title: base.title})
        })
        return
      }
      if (action === 'reindex') {
        await run('正在更新检索索引', async () => {
          const {data} = await api.post(`/novels/${novelId}/chapters/${item.chapter_idx}/reindex`)
          await openProject(chapterIdx); notice.success(data.message || '索引已更新')
        })
        return
      }
      if (action === 'delete') modal.confirm({
        title: `删除第 ${item.chapter_idx} 章「${item.title || '未命名章节'}」？`,
        content: '本章正文、台本及相关生成和修订记录将被删除。请先导出需要保留的内容。',
        okText: '删除章节', okType: 'danger', cancelText: '取消',
        onOk: () => run('正在删除章节', async () => {
          const target = await deskApi<Chapter>(`/chapter/${item.chapter_idx}`)
          if (target.id) await api.delete(`/novels/${novelId}/chapters/${target.id}`)
          await openProject(chapterIdx === item.chapter_idx ? undefined : chapterIdx)
          notice.success('章节已删除')
        }),
      })
    })
  }
  async function renameChapter() {
    if (!renaming?.title.trim()) { notice.warning('请填写章节标题'); return }
    await run('正在重命名章节', async () => {
      const saved = await deskApi<Chapter>('/save', {...renaming.base, chapter_idx: renaming.idx, title: renaming.title.trim(), base_chapter: renaming.base})
      if (renaming.idx === chapterIdx) { setChapter(saved); setBaseChapter(saved) }
      setChapters(list => list.map(item => item.chapter_idx === renaming.idx ? {...item, id: saved.id, title: saved.title} : item))
      setRenaming(null); notice.success('章节已重命名')
    })
  }
  async function importLore(file: File) {
    try {
      if (file.size > 300000) throw new Error('设定文件过大，请使用 300 KB 以内的 JSON 文件')
      const data: unknown = JSON.parse(await file.text())
      if (!Array.isArray(data) || data.length > 500 || !data.every(entry => entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 200 && typeof entry.title === 'string' && entry.title.length <= 500 && typeof entry.text === 'string' && entry.text.length <= 50000 && Array.isArray(entry.keys) && entry.keys.length <= 100 && entry.keys.every((key: unknown) => typeof key === 'string' && key.length <= 500) && typeof entry.enabled === 'boolean' && typeof entry.always_on === 'boolean' && typeof entry.category === 'string' && entry.category.length <= 200)) throw new Error('请导入本工具导出的 Lorebook JSON，条目结构不完整')
      if (new Set(data.map(entry => entry.id)).size !== data.length) throw new Error('文件中的条目 ID 重复，请检查后重试')
      setImportedLore(data.map(entry => ({ id: entry.id, title: entry.title, text: entry.text, keys: entry.keys, enabled: entry.enabled, always_on: entry.always_on, category: entry.category })))
    } catch (e) { report(e) }
  }
  function exportLore() {
    if (!settings) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(settings.lorebook, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'mountain-view-lorebook.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function finishImport(replace: boolean) {
    if (!settings || !importedLore) return
    const merged = replace ? importedLore : [...settings.lorebook, ...importedLore.map(entry => ({ ...entry, id: settings.lorebook.some(old => old.id === entry.id) ? crypto.randomUUID() : entry.id }))]
    if (merged.length > 500) { notice.warning('合并后超过 500 个条目，请精简后导入'); return }
    editSettings({ lorebook: merged }); setImportedLore(null); notice.success('设定已导入编辑区，保存后生效')
  }
  const visibleLore = settings?.lorebook.filter(entry => (!loreCategory || entry.category === loreCategory) && `${entry.title}\n${entry.category}\n${entry.keys.join(' ')}`.toLowerCase().includes(search.toLowerCase())) ?? []
  async function polishLore() {
    if (!loreEdit?.title.trim() || !loreEdit.text.trim()) { notice.warning('请填写条目名称和设定正文'); return }
    if (!settings?.model_id) { notice.warning('请先在参数中选择创作模型'); return }
    const source = {...loreEdit}
    await run('正在整理润色设定', async () => {
      const result = await deskApi<{ text: string; context: StoryContext }>('/lore/polish', {...requestBody(), lore_entry: source})
      setLorePolish({source, text: result.text, model: result.context.model?.name || '当前创作模型'})
    })
  }
  function acceptLorePolish() {
    if (!lorePolish || !loreEdit || locked) return
    if (JSON.stringify(loreEdit) !== JSON.stringify(lorePolish.source)) { notice.warning('条目已变化，请根据当前内容重新整理'); return }
    setLoreEdit({...loreEdit, text: lorePolish.text}); setLorePolish(null)
    notice.success('已采纳到条目编辑区，点击“完成编辑”后保存项目设置')
  }
  const saveLore = () => {
    if (!loreEdit?.title.trim() || !loreEdit.text.trim()) { notice.warning('请填写条目名称和设定正文'); return }
    const cleaned = { ...loreEdit, keys: Array.from(new Set(loreEdit.keys.map(key => key.trim()).filter(Boolean))) }
    if (cleaned.keys.length > 100 || cleaned.keys.some(key => key.length > 500)) { notice.warning('最多 100 个触发词，每个不超过 500 字符'); return }
    editSettings({ lorebook: settings!.lorebook.some(entry => entry.id === loreEdit.id) ? settings!.lorebook.map(entry => entry.id === loreEdit.id ? cleaned : entry) : [...settings!.lorebook, cleaned] })
    setLoreEdit(null)
  }

  return <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: visualTheme === 'dragon' ? '#d8ac69' : '#d9bd80', colorBgBase: visualTheme === 'dragon' ? '#111b19' : '#15171c', colorTextBase: '#e8e4db', borderRadius: 8, fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif' } }}>
    {noticeHolder}{modalHolder}
    <div className={`writing-app mv-writing-desk theme-${visualTheme}`}>
      {mobilePanel && <button className="panel-backdrop mobile-only" aria-label="收起侧栏" onClick={() => setMobilePanel(null)} />}
      <aside className={`library-panel ${mobilePanel === 'chapters' ? 'mobile-open' : ''}`}>
        <Button className="mobile-only panel-close" type="text" icon={<CloseOutlined />} aria-label="关闭章节侧栏" onClick={() => setMobilePanel(null)} />
        <Button className="back-to-library" type="text" icon={<ArrowLeftOutlined />} disabled={locked || Boolean(recovery)} onClick={backToLibrary}>返回书架</Button><div className="brand"><div className="brand-icon"><BookOutlined /></div><div className="book-identity"><Tooltip title="作品设置"><button className="book-settings-trigger" aria-label="作品设置" disabled={locked || Boolean(recovery)} onClick={() => openTool(() => onOpenTool('settings'))}><strong title={novelTitle}>{novelTitle}</strong><SettingOutlined /></button></Tooltip><span>故事，由你执笔</span></div></div>
        <div className="library-heading"><span>我的章节</span><Tooltip title="新建章节"><Button aria-label="新建章节" type="text" icon={<PlusOutlined />} disabled={locked || !settings} onClick={newChapter} /></Tooltip></div>
        <nav className="chapter-list" aria-label="章节列表">{chapters.map(item => <div key={item.chapter_idx} className={`chapter-row ${item.chapter_idx === chapterIdx ? 'active' : ''}`}>
          <button disabled={locked} className={`chapter-card ${item.chapter_idx === chapterIdx ? 'active' : ''}`} onClick={() => loadChapter(item.chapter_idx)}>
            <span className="chapter-number">CHAPTER {String(item.chapter_idx).padStart(2, '0')}</span>
            <strong>{item.chapter_idx === chapterIdx ? chapter.title || '未命名章节' : item.title || '未命名章节'}</strong>
            <span className="chapter-status"><span className={`status-dot ${item.has_content ? 'filled' : ''}`} />{item.chapter_idx === chapterIdx && chapterDirty ? '尚未保存' : item.status === 'finalized' ? '已定稿' : item.status === 'needs_review' ? '待核对' : item.has_content ? '已保存正文' : '等待落笔'}</span>
          </button>
          <Dropdown trigger={['click']} menu={{items: [
            {key: 'rename', label: '重命名', icon: <EditOutlined />},
            {key: 'versions', label: '台本版本', icon: <HistoryOutlined />},
            ...(canReindex && item.status === 'finalized' ? [{key: 'reindex', label: '更新检索索引'}] : []),
            {type: 'divider' as const},
            {key: 'delete', label: '删除章节', danger: true, icon: <DeleteOutlined />},
          ], onClick: ({key}) => void chapterAction(item, key)}}>
            <Button className="chapter-menu" type="text" size="small" aria-label={`第 ${item.chapter_idx} 章操作`} icon={<MoreOutlined />} disabled={locked || Boolean(recovery)} />
          </Dropdown>
        </div>)}</nav>
        <div className="library-footer"><span className="tiny-label">全书导出</span><div className="book-downloads"><Button block icon={<DownloadOutlined />} disabled={locked || !settings} onClick={() => downloadBook('txt')}>下载全书 TXT</Button><Button block disabled={locked || !settings} onClick={() => downloadBook('md')}>下载 Markdown</Button><Button block disabled={locked || !settings} onClick={() => downloadBook('json')}>备份项目 JSON</Button></div></div>
      </aside>

      <main className="manuscript-panel">
        <header className="editor-topbar"><div className="mobile-navigation mobile-only"><Button aria-label="打开章节目录" type="text" icon={<BookOutlined />} onClick={() => setMobilePanel('chapters')} /><Button aria-label="打开写作设置" type="text" icon={<SettingOutlined />} onClick={() => setMobilePanel('settings')} /></div><div className="document-path"><FileTextOutlined /><span className="path-label">创作手稿</span><span className="path-separator">/</span><span>第 {chapterIdx} 章</span></div><div className="top-actions"><Select className="theme-selector" aria-label="写作台主题" value={visualTheme} suffixIcon={<SkinOutlined />} options={[{value: 'dark', label: '经典深色'}, {value: 'dragon', label: '龙与地下城'}]} onChange={value => {
          setVisualTheme(value)
          try { localStorage.setItem(themeKey, value) } catch { notice.warning('主题已切换，但浏览器无法记住偏好') }
        }} /><span className={`save-status ${settingsDirty ? 'unsaved' : ''}`}>{settingsDirty ? '项目设置未保存' : '项目设置已保存'}</span><Button icon={<HistoryOutlined />} disabled={locked || !settings} onClick={showHistory}>生成记录</Button><Tooltip title="仅保存本书 Memory、Lorebook 和写作参数。正文、章节标题、台本和作者批注独立自动保存。"><Button icon={<SaveOutlined />} disabled={locked || !settings || !settingsDirty} onClick={saveSettings}>保存修改</Button></Tooltip></div></header>
        {error && <div className="error-banner"><Alert type="error" showIcon closable onClose={() => setError('')} message={error} action={!settings ? <Button size="small" onClick={() => openProject()} disabled={locked}>重试</Button> : undefined} /></div>}
        {draftError && <div className="error-banner"><Alert type="warning" showIcon message={draftError} /></div>}
        {!settings ? <div className="opening-state">{busy ? <><Spin /><p>正在打开你的写作空间…</p></> : <Empty description="暂时无法打开项目"><Button onClick={() => openProject()}>重新打开</Button></Empty>}</div> : <>
          <div className="manuscript-scroll">
            <div className="manuscript-inner">
              <div className="chapter-eyebrow">CHAPTER {String(chapterIdx).padStart(2, '0')}<span> / 自由创作</span></div>
              <input className="chapter-title" aria-label="章节标题" placeholder="给这一章起个名字" maxLength={500} value={chapter.title} disabled={locked} onChange={event => editChapter({ title: event.target.value })} />
              <Collapse className="script-collapse" defaultActiveKey={['script']} ghost items={[{ key: 'script', label: <span><FileTextOutlined /> 本章台本 <span className="quiet-label">你的剧情，由 AI 展开</span></span>, children: <Input.TextArea aria-label="本章完整台本" disabled={locked} autoSize={{ minRows: 4, maxRows: 12 }} maxLength={100000} value={chapter.raw_script} placeholder="直接粘贴完整台本，包括事件顺序、关键对白和结束位置。不需要拆场景。" onChange={event => editChapter({ raw_script: event.target.value })} /> }]} />
              <div className="script-tools"><Button size="small" disabled={locked || Boolean(recovery)} onClick={() => openTool(() => onOutlineReview(chapterIdx))}>AI 整理台本</Button><Button size="small" disabled={locked || Boolean(recovery)} onClick={() => openTool(() => onOutlineVersions(chapterIdx))}>台本版本</Button></div>
              {preparation?.chapter_idx === chapterIdx && !preparation.preparation_warning && <section className="chapter-note" aria-label="写前核对结果">
                {preparation.preparation.conflicts.length > 0 && <Alert type="warning" showIcon message="材料时间点或事实存在冲突" description={<div>{preparation.preparation.conflicts.map((item, i) => <p key={i}>{item.source}「{item.quote}」<br />台本「{item.plan_quote}」<br />{item.problem}</p>)}<p>请修改对应材料后重新生成。系统没有自动选择版本或更新 Memory。</p></div>} />}
                <Collapse ghost items={[{key: 'preparation', label: '本次写前核对 · 事实边界与文风', children: <>
                  <p className="panel-footnote">由本次材料整理，不是另一份记忆。正文生成仍按完整台本执行。</p>
                  {preparation.preparation.facts.map((item, i) => <p key={i}>「{item.quote}」<br />{item.note}</p>)}
                  {preparation.preparation.style_rules.map((item, i) => <p key={i}>{item.rule}<br /><span className="quiet-label">依据：{item.quote}</span></p>)}
                  <Button size="small" onClick={() => setContextView({title: '写前核对实际请求', context: preparation.context})}>查看核对材料</Button>
                </>}]} />
              </section>}
              <section className="chapter-note" aria-label="本章作者批注"><div className="section-heading"><h3>本章作者批注</h3><div className="section-tools"><Tag bordered={false}>仅本章</Tag><Button aria-label="展开作者批注" type="text" size="small" icon={<ExpandOutlined />} disabled={locked} onClick={() => setExpanded('author_note')} /></div></div><p>本章的视角、语气与特别提醒，随章节独立保存。</p><Input.TextArea aria-label="作者批注" autoSize={{ minRows: 2, maxRows: 6 }} disabled={locked} maxLength={20000} value={chapter.author_note} placeholder="第三人称有限视角。让关系通过动作和对白自然显现，不提前揭露身份。" onChange={event => editChapter({ author_note: event.target.value })} /></section>
              <div className="prose-heading"><Tooltip title={proseCountHint}><strong className="prose-count" aria-label={`正文字数：${proseCount} 字，含标点不含空白`}>正文 · {proseCount} 字{lengthRange && <small> · 目标 {lengthRange.min}–{lengthRange.max} 字</small>}</strong></Tooltip><span>可直接编辑 · 选中文字后定向修改</span></div>
              {chapterSaveError && <Alert type="error" showIcon message="本章自动保存失败，当前编辑仍保留" description={chapterSaveError} action={<Button disabled={locked} onClick={() => void saveChapter()}>重试保存本章</Button>} />}
              {lengthWarning && <Alert type="warning" showIcon message={lengthWarning} description={proseChars < (lengthRange?.min || 0) ? '台本未写完可点击“继续写”；已写完则补充现有情节细节，或选中文字要求扩写，保持原有剧情与章节落点。' : '可以选中冗余段落要求精简，保留台本事件和关键线索。'} />}
              {chapter.incomplete && <Alert type="warning" showIcon message="正文未完成：生成达到单次输出上限" description="已保留收到的正文。可以继续写，也可以手工补全；请核对台本是否全部落实后再定稿。" action={<div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}><Button size="small" disabled={locked || !chapter.raw_script.trim()} onClick={() => generate('continue')}>继续完成本章</Button><Button size="small" disabled={locked} onClick={() => modal.confirm({title: '确认已手工补全正文？', content: '请核对章节结尾与台本要求。确认后解除未完成标记，并自动保存。', okText: '已核对并补全', cancelText: '继续编辑', onOk: () => editChapter({incomplete: false})})}>我已手工补全</Button></div>} />}
              <textarea ref={editor} className="prose-editor" aria-label="小说正文" value={chapter.content} disabled={locked} maxLength={500000} spellCheck={false} placeholder={'故事从这里开始。\n\n写好台本后，点击「台本生成正文」。\n你可以直接改动文字，也可以选中一段，让 AI 按你的想法重写。'} onChange={event => { editChapter({ content: event.target.value }); setSelection(null) }} onSelect={event => { if (locked) return; const element = event.currentTarget; const start = element.selectionStart; const end = element.selectionEnd; if (start !== end) setSelection({ chapter_idx: chapterIdx, before: element.value.slice(0, start), selected: element.value.slice(start, end), after: element.value.slice(end) }) }} />
              {quality?.chapter_idx === chapterIdx && <section className="chapter-note" aria-label="写后核对结果">
                <h3>本轮精修诊断 {qualityCurrent ? '' : '· 结果已过期，可重新全文精修'}</h3>
                <p>{quality.review.summary}</p>
                <p className="panel-footnote">正文 {quality.length.chars.toLocaleString()} 字，目标 {quality.length.min}–{quality.length.max} 字。{quality.length.status === 'short' ? quality.review.raw || !quality.review.beats?.length ? '尚不能确认台本是否写全，可点击「全文精修」检查。' : quality.review.beats.some(b => b.status !== '已写') ? '有事件尚未充分落实，可按台本补写。' : '台本已覆盖，篇幅偏短；可展开已有情节，不在章尾添加新剧情凑字。' : quality.length.status === 'long' ? '篇幅偏长，可压缩重复表达。' : '字数在目标范围内。'}核对是模型建议，定稿仍需作者判断。</p>
                {quality.review.raw ? <Alert type="warning" message="核对结果未成功解析，可点击「全文精修」重新检查；正文已保留" description={<pre>{quality.review.raw}</pre>} /> : <Collapse ghost items={[{key: 'issues', label: `查看 ${quality.review.issues.length} 项意见与台本核对`, children: <>
                  {quality.review.beats?.map(b => <p key={b.point}>{b.point}. {b.text} · {b.status}{b.quote && `「${b.quote}」`}</p>)}
                  {quality.review.issues.map((item, i) => <p key={i}><Tag>{item.layer || item.dimension}</Tag><Tag>{item.severity}</Tag>{item.resolution === 'author_decision' && <Tag>需作者决定或核对依据</Tag>}{item.problem}<br />{item.quote && `「${item.quote}」`}<br />{item.suggestion}</p>)}
                </>}]} />}

                <Button type="text" onClick={() => setContextView({title: '写后核对实际请求', context: quality.context})}>查看核对依据</Button>
              </section>}
              <section className="prose-actions" aria-label="正文审校与定稿">
                <span>{chapter.incomplete ? '正文尚未完成，请继续写或手工补全后再定稿。' : dirty ? settingsDirty ? '请先保存项目设置，再定稿。' : '正在等待本章自动保存，再定稿。' : '定稿时自动整理 Memory，核对后一起保存。'}</span>
                <div className="prose-action-buttons">
                  <Tooltip title="生成完成后自动精修；修改正文、台本、批注或文风后，可手动再精修一次"><Button type="primary" disabled={locked || Boolean(recovery) || chapter.incomplete || !chapter.content.trim() || !chapter.raw_script.trim()} onClick={suggestRepair}>全文精修</Button></Tooltip>
                  <Tooltip title={chapter.incomplete ? '请先继续写或手工补全正文并保存' : dirty ? '先保存正文和写作设置，再自动整理记忆' : '自动整理 Memory，核对后更新记忆并定稿'}><Button icon={<CheckCircleOutlined />} disabled={locked || dirty || chapter.incomplete || !chapter.content.trim()} onClick={() => suggestMemory(true)}>确认定稿</Button></Tooltip>
                </div>
              </section>
              <div className="manuscript-end"><span />✦<span /></div>
            </div>
          </div>
          {selection && <div className="selection-bar"><div className="selection-header"><span><EditOutlined /> 修改选段 <small>{Array.from(selection.selected).length} 字符</small></span><Button type="text" size="small" icon={<CloseOutlined />} aria-label="取消选段" disabled={locked} onClick={() => setSelection(null)} /></div><div className="revision-shortcuts">{['润色', '扩写', '精简'].map(action => <Button key={action} size="small" disabled={locked} onClick={() => setInstruction(action === '润色' ? '保留情节与信息，润色这段文字，减少套话，以具体动作和对白表达。' : action === '扩写' ? '保留情节与人物动机，补充有用的动作、对白与感官细节，将本段写得更充分。' : '保留关键信息与情节，精简重复表达和过度修饰，让这段更紧凑。')}>{action}</Button>)}</div><Input.TextArea aria-label="选段修改要求" placeholder="例如：保留剧情，让老赵更嘴硬，减少解释情绪的旁白。" autoSize={{ minRows: 1, maxRows: 3 }} maxLength={20000} disabled={locked} value={instruction} onChange={event => setInstruction(event.target.value)} /><Button type="primary" disabled={locked || !instruction.trim()} icon={<EditOutlined />} onClick={revise}>生成修改建议</Button></div>}
          <footer className="generation-bar"><div className="generation-meta"><Tooltip title={proseCountHint}><strong className="prose-count">正文 {proseCount} 字</strong></Tooltip><span className="meta-dot">·</span>{locked ? <span><LoadingOutlined /> {busy || '正在自动保存本章'}</span> : <span>第 {chapterIdx} 章 · {chapterSaveError ? '自动保存失败' : chapterDirty ? '等待自动保存（停止编辑 3 秒）' : '本章已自动保存'} · 含标点，不含空白</span>}</div><div className="generation-actions"><Tooltip title="恢复上一份 AI 修改前的正文"><Button icon={<UndoOutlined />} aria-label="撤销 AI 修改" disabled={locked || !undo.length} onClick={() => { editChapter(undo[undo.length - 1]); setUndo(history => history.slice(0, -1)); setSelection(null) }}>撤销</Button></Tooltip><Button disabled={locked || !chapter.content.trim() || !chapter.raw_script.trim()} onClick={() => generate('continue')}>继续写</Button><Button type="primary" icon={<SendOutlined />} disabled={locked || !chapter.raw_script.trim()} onClick={() => generate('write')}>台本生成正文</Button></div></footer>
        </>}
      </main>

      <aside className={`inspector-panel ${mobilePanel === 'settings' ? 'mobile-open' : ''}`}><Button className="mobile-only panel-close" type="text" icon={<CloseOutlined />} aria-label="关闭写作设置" onClick={() => setMobilePanel(null)} /><Tabs activeKey={inspectorTab} onChange={setInspectorTab} items={[
        { key: 'writing', label: '写作', children: settings && <div className="inspector-content"><div className="inspector-intro"><span className="tiny-label">BOOK MEMORY</span><h2>全书一份有效记忆</h2><p>切换章节仍共用当前 Memory。本章作者批注在编辑区单独填写。</p></div><section className="setting-section"><div className="section-heading"><h3>Memory</h3><div className="section-tools"><Button type="text" size="small" icon={<HistoryOutlined />} disabled={locked || !settings} onClick={showMemoryHistory}>历史</Button><Tag bordered={false}>全书唯一 · 常驻</Tag><Button aria-label="展开 Memory" type="text" size="small" icon={<ExpandOutlined />} disabled={locked} onClick={() => setExpanded('memory')} /></div></div><p>全书只维护这一份当前有效记忆，生成和审稿共用。历史版本仅供查看，不再叠加各章或前 N 章的差分摘要。定稿时自动整理建议，核对后更新；回头重写时，可恢复本章开始前的记忆。</p><p aria-label="记忆进度"><strong>{settings.memory_through_chapter === undefined ? '记忆进度尚未确认' : settings.memory_through_chapter === 0 ? '记忆进度：开篇之前' : `记忆已更新至第 ${settings.memory_through_chapter} 章结束`}</strong></p><p className="panel-footnote">进度随记忆整理和定稿自动更新。回头重写已定稿章节时，可预览并恢复该章开始前的记忆，当前版本会先备份。</p><Button block disabled={locked || Boolean(recovery)} onClick={() => previewMemoryRestore()}>重写本章 · 恢复章前记忆</Button><Input.TextArea aria-label="Memory" autoSize={{ minRows: 8, maxRows: 16 }} disabled={locked} maxLength={100000} value={settings.memory} placeholder="记录已经发生的事实，区分人物猜测与已证实的信息。" onChange={event => editSettings({ memory: event.target.value })} /><Tooltip title={chapterDirty ? '等待本章自动保存完成，再整理记忆' : '根据已保存正文生成建议，确认后才更新 Memory'}><Button block icon={<BulbOutlined />} disabled={locked || chapterDirty || !chapter.content.trim()} onClick={() => suggestMemory()}>根据本章正文整理建议</Button></Tooltip></section><section className="setting-section context-section"><h3>AI 看到了什么</h3><p>查看近期正文、记忆与本次激活的设定。</p><Button block icon={<EyeOutlined />} disabled={locked} onClick={() => preview()}>本次上下文</Button><Button block icon={<HistoryOutlined />} disabled={locked || !chapter.last_context} onClick={() => chapter.last_context && setContextView({ title: '上次实际请求', context: chapter.last_context })}>上次实际请求</Button><Collapse ghost items={[{key: 'advanced-context', label: '高级 · 模型调试', children: <><p className="panel-footnote">查看调用日志、错误详情，或独立测试模型。</p><Button block icon={<BugOutlined />} disabled={locked} onClick={onDebug}>打开模型调试</Button></>}]} /></section></div> },
        { key: 'lore', label: 'Lorebook', children: settings && <div className="inspector-content"><div className="inspector-intro"><span className="tiny-label">WORLD & CHARACTERS</span><h2>故事设定集</h2><p>世界观、人物、地点和规则统一保存在 Lorebook。关键词命中时带入写作；常驻条目始终带入。旧资料的差异已保留为停用条目，可核对后采纳。</p></div><Input.Search aria-label="搜索设定" placeholder="搜索名称、分类或关键词" value={search} onChange={event => setSearch(event.target.value)} /><Select aria-label="设定分类" className="lore-category" placeholder="全部分类" allowClear value={loreCategory} onChange={setLoreCategory} options={Array.from(new Set(settings.lorebook.map(entry => entry.category).filter(Boolean))).map(value => ({value, label: value}))} /><Button className="add-lore" block icon={<PlusOutlined />} disabled={locked} onClick={newLore}>新增设定条目</Button><div className="lore-transfer"><label className={`import-label ${locked ? 'disabled' : ''}`}><UploadOutlined /> 导入<input aria-label="导入设定 JSON" type="file" accept=".json,application/json" disabled={locked} onChange={event => { const file = event.target.files?.[0]; if (file) void importLore(file); event.target.value = '' }} /></label><Button type="text" size="small" icon={<DownloadOutlined />} disabled={locked} onClick={exportLore}>导出</Button></div><div className="lore-list">{visibleLore.map(entry => <div className={`lore-card ${!entry.enabled ? 'disabled-lore' : ''}`} key={entry.id}><div className="lore-card-heading"><button disabled={locked} onClick={() => setLoreEdit({ ...entry, keys: [...entry.keys] })}><BookOutlined /> {entry.title || '未命名条目'}</button><Switch aria-label={`启用${entry.title}`} size="small" disabled={locked} checked={entry.enabled} onChange={enabled => editSettings({ lorebook: settings.lorebook.map(item => item.id === entry.id ? { ...item, enabled } : item) })} /></div><p>{entry.text}</p><div className="lore-tags">{entry.category && <Tag>{entry.category}</Tag>}{entry.always_on ? <Tag color="gold">常驻</Tag> : entry.keys.slice(0, 3).map(key => <Tag key={key}>{key}</Tag>)}{!entry.always_on && !entry.keys.length && <span className="quiet-label">尚未设置触发词</span>}</div></div>)}{!visibleLore.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有匹配的设定" />}</div><p className="panel-footnote">修改设定后，点击顶部「保存修改」保存。</p></div> },
        { key: 'parameters', label: '参数', children: settings && <div className="inspector-content"><div className="inspector-intro"><span className="tiny-label">WRITING PREFERENCES</span><h2>写作偏好</h2><p>保持设置简单，先让故事自然发生。</p></div><section className="setting-section model-settings"><h3>创作模型</h3><Select aria-label="创作模型" value={settings.model_id} disabled={locked} options={models.map(item => ({ value: item.id, label: item.name + ' · ' + item.model }))} onChange={model_id => editSettings({ model_id })} /><div className="model-actions"><Button disabled={locked} onClick={() => openTool(() => onOpenTool('llm-configs'))}>管理模型</Button></div><p>生成正文、选段改写和记忆建议共用这里选择的模型。</p></section><section className="setting-section"><h3>文风</h3><p>管理文风指南与范文片段，用于整章生成和选段修改。</p><Button block icon={<EditOutlined />} disabled={locked} onClick={() => openTool(() => onOpenTool('style'))}>文风与范文</Button></section><section className="setting-section"><h3>固定写作要求 <Tag>默认模板 · 可编辑</Tag></h3><p>已预填通用创作与去 AI 味模板，你可以直接修改、删减或补充。整章生成、续写和正文修订使用当前内容，删除的规则不会自动补回。</p><Input.TextArea aria-label="固定写作要求" disabled={locked} autoSize={{ minRows: 10, maxRows: 18 }} maxLength={50000} value={settings.system_prompt} onChange={event => editSettings({ system_prompt: event.target.value })} /><Button size="small" disabled={locked || !writingTemplate || settings.system_prompt === writingTemplate} onClick={() => modal.confirm({ title: '恢复默认写作模板？', content: '将替换当前固定写作要求，保存后对全书生效。文风参考和作者批注保留。', okText: '恢复默认', cancelText: '取消', onOk: () => editSettings({ system_prompt: writingTemplate }) })}>恢复默认模板</Button><p>写法冲突时：本次要求与作者批注优先，其次作者明确自定义要求，再次文风参考，最后是模板保留的默认建议。</p></section><section className="setting-section parameter-fields"><label>上下文容量<InputNumber aria-label="上下文容量" disabled={locked} min={1024} max={2000000} step={1024} value={settings.context_tokens} onChange={value => value !== null && editSettings({ context_tokens: value })} /></label><p>填写服务商实际窗口，用于输出预留和自动裁剪，不会改变云端模型容量。</p><label>创作变化 <InputNumber aria-label="创作变化" disabled={locked} min={0} max={2} step={0.05} value={settings.temperature} onChange={value => value !== null && editSettings({ temperature: value })} /></label><p>较低更稳定，较高带来更多变化。</p><label>单次输出上限 <InputNumber aria-label="单次输出上限" disabled={locked} min={128} max={32768} step={128} value={settings.max_output_tokens} onChange={value => value !== null && editSettings({ max_output_tokens: value })} /></label><p>按模型 token 计算，不等于中文字数。</p><label>前章正文范围 <InputNumber aria-label="前章正文范围" disabled={locked} min={0} max={6000} step={500} value={settings.recent_context_chars} onChange={value => value !== null && editSettings({ recent_context_chars: value })} /></label><p>带入已保存前章的结尾，最多这些字符。0 表示不带入。</p></section></div> },
      ]} /></aside>
    </div>

    <Modal title="全文精修 · 复核后对比采用" open={Boolean(repair)} onCancel={() => !locked && setRepair(null)} width={1000}
      footer={<><Button disabled={locked} onClick={() => setRepair(null)}>保留原稿</Button><Button type="primary" disabled={locked || !repair?.applied.length || repair.source !== JSON.stringify(requestBody())} onClick={acceptRepair}>采用通过复核的修改</Button></>}>
      <p>已完成一轮故事、用笔、表达诊断与定点修订；有修改时已进行候选复核。仅采用下列通过复核的补丁，其余正文保持原样。模型核验仍可能漏判，请对比后采用。</p>
      {repair?.diagnosis && <p>{repair.diagnosis.summary}</p>}
      {repair?.length && <p>正文 {repair.length.before.toLocaleString()} → {repair.length.chars.toLocaleString()} 字；目标 {repair.length.min}–{repair.length.max} 字。{repair.length.status === 'short' ? '篇幅仍偏短，不自动添加新剧情凑字。' : repair.length.status === 'long' ? '篇幅仍偏长。' : '字数在目标范围内。'}</p>}
      {repair?.audit?.warning && <Alert type="warning" message={repair.audit.warning} />}
      {!repair?.applied.length && <Alert type="info" message="本轮没有可采用的修改，原稿保留。" />}
      {!!repair?.author_decisions?.length && <Collapse items={[{key: 'decisions', label: `需作者决定或核对依据 · ${repair.author_decisions.length} 项`, children: repair.author_decisions.map((i, n) => <p key={n}><strong>{i.layer || i.dimension} · {i.problem}</strong><br />{i.quote && `「${i.quote}」`}<br />{i.suggestion}</p>)}]} />}
      {!!repair?.blocked?.length && <Collapse items={[{key: 'blocked', label: `未放行的修改 · ${repair.blocked.length} 项`, children: repair.blocked.map((b, n) => <section key={n}><strong>{b.patch.note}</strong><p>{b.reason}</p><pre style={{whiteSpace: 'pre-wrap'}}>{b.patch.replace || '（删除）'}</pre></section>)}]} />}
      {repair?.contexts && <div>{(['diagnosis', 'revision', 'audit'] as const).map((key, i) => repair.contexts?.[key] && <Button key={key} type="text" onClick={() => setContextView({title: ['精修诊断请求', '定点修订请求', '候选复核请求'][i], context: repair.contexts![key]!})}>{['诊断依据', '改稿请求', '复核依据'][i]}</Button>)}</div>}
      {!!repair?.failed.length && <Alert type="warning" message={`${repair.failed.length} 处建议无法唯一定位，已跳过，未改动对应原文。`} />}
      {repair?.applied.map((patch, i) => <section key={i} className="revision-preview"><h4>{patch.note}</h4><div className="comparison"><div><h4>原文</h4><pre style={{whiteSpace: 'pre-wrap'}}>{patch.find}</pre></div><div><h4>替换文字</h4><pre style={{whiteSpace: 'pre-wrap'}}>{patch.replace || '（删除）'}</pre></div></div></section>)}
    </Modal>
    <Modal title={`重命名第 ${renaming?.idx || ''} 章`} open={Boolean(renaming)} onCancel={() => !locked && setRenaming(null)} onOk={renameChapter}
      okText="保存标题" cancelText="取消" confirmLoading={locked} maskClosable={!locked} closable={!locked} okButtonProps={{disabled: locked || !renaming?.title.trim()}} cancelButtonProps={{disabled: locked}}>
      <Input aria-label="新的章节标题" maxLength={500} value={renaming?.title || ''} disabled={locked} onChange={event => setRenaming(current => current ? {...current, title: event.target.value} : current)} />
    </Modal>
    <Drawer title="记忆历史" open={memoryHistoryOpen} onClose={() => setMemoryHistoryOpen(false)} width="min(800px, 100vw)">
      <p className="panel-footnote">历史版本保留完整记忆。可预览并恢复适用于当前正文的版本；恢复前自动备份当前记忆，章节正文不会改动。</p>
      <Select aria-label="记忆历史版本" style={{width: '100%'}} placeholder="选择历史版本" value={memoryVersion?.id} disabled={locked}
        options={memoryVersions.map(version => ({value: version.id, label: `${memoryVersionLabels[version.kind] || version.kind}${version.memory_through_chapter == null ? ' · 进度未知' : version.memory_through_chapter === 0 ? ' · 开篇前' : ` · 至第 ${version.memory_through_chapter} 章`}${version.restorable ? '' : ' · 仅供查看'} · ${new Date(version.created_at).toLocaleString()}`}))}
        onChange={version => run('正在读取历史版本', async () => setMemoryVersion(await deskApi<MemoryVersion>(`/memory/history/${version}`)))} />
      {memoryVersion ? <><p className="panel-footnote">{memoryVersion.title} · {memoryVersion.created_by}</p><pre className="memory-snapshot-preview">{memoryVersion.memory || '（当时的 Memory 为空）'}</pre>{!memoryVersion.restorable && <p>{memoryVersion.restore_reason}</p>}<Button type="primary" disabled={locked || !memoryVersion.restorable} onClick={() => previewMemoryRestore(memoryVersion.id)}>预览恢复此版本</Button></> : <Empty description="尚无记忆历史" />}
    </Drawer>
    <Modal title={memoryRestore?.target_chapter ? `重写第 ${memoryRestore.target_chapter} 章 · 恢复章前记忆` : '恢复历史 Memory'} open={Boolean(memoryRestore)} width={900}
      onCancel={() => !locked && setMemoryRestore(null)} onOk={restoreMemory} okText="备份当前记忆并恢复" cancelText="暂不恢复" confirmLoading={locked} okButtonProps={{disabled: locked || !memoryRestore?.restorable}} cancelButtonProps={{disabled: locked}} closable={!locked} maskClosable={!locked}>
      {memoryRestore && <>{memoryRestore.restorable ? <><p>将恢复到{memoryRestore.memory_through_chapter === 0 ? '开篇之前' : `第 ${memoryRestore.memory_through_chapter} 章结束`}的记忆，并保存当前项目设置。原有记忆和未保存的记忆编辑会先留存备份；恢复不改动任何章节正文。恢复后可重新生成本章。</p>
        {memoryRestore.empty_opening && <Alert type="info" message="没有可用的开篇前快照。可明确选择使用空 Memory 从第一章重新开始；人物与世界设定仍保留。" />}
        <div className="comparison"><div><h4>当前记忆 · 将保留备份</h4><pre>{memoryRestore.settings.memory || '（空记忆）'}</pre></div><div><h4>恢复后的记忆</h4><pre>{memoryRestore.memory || '（空记忆）'}</pre></div></div></> : <Alert type="warning" message="暂时没有可恢复的章前记忆" description={memoryRestore.restore_reason} />}</>}
    </Modal>
    <Modal title="恢复上次未保存的编辑" open={Boolean(recovery)} closable={false} maskClosable={false} footer={null}>
      {recovery && <><p>第 {recovery.chapter_idx} 章 · 备份于 {new Date(recovery.saved_at).toLocaleString()}。服务器定稿保持原样，请选择恢复编辑或使用已保存版本。</p><div className="recovery-actions"><Button disabled={locked} onClick={() => setRecovery(null)}>使用已保存版本</Button><Button type="primary" disabled={locked} onClick={() => { setChapter(recovery.chapter); setBaseChapter(recovery.base_chapter); setSettings(recovery.settings); setBaseSettings(recovery.base_settings); setRecovery(null) }}>恢复未保存草稿</Button></div></>}
    </Modal>
    <Drawer title={`第 ${chapterIdx} 章 · 生成记录`} open={historyOpen} onClose={() => setHistoryOpen(false)} width={760}>
      <p className="panel-footnote">正文与核对结果自动归档，刷新后仍可查看。核对与修订建议不会自行覆盖正文。恢复草稿后，3 秒后自动保存。</p>
      <div className="history-list">{history.map(item => <Button key={item.id} type={artifact?.id === item.id ? 'primary' : 'default'} block disabled={locked} onClick={() => run('正在打开生成记录', async () => setArtifact(await deskApi<Artifact>(`/chapter/${chapterIdx}/history/${item.id}`)))}>{historyLabels[item.kind]} · {new Date(item.created_at).toLocaleString()}</Button>)}{!history.length && <Empty description="本章还没有生成记录" />}</div>
      {artifact && <section className="history-preview"><h3>{historyLabels[artifact.kind]}{artifact.incomplete && <Tag color="warning">输出截断 · 未完成</Tag>}</h3><p>{artifact.context.model?.name} · {artifact.context.model?.model}</p>{!['prepare', 'check'].includes(artifact.kind) && <Button disabled={locked || (artifact.kind === 'memory' && (chapterDirty || !chapter.content.trim()))} onClick={restoreArtifact}>{artifact.kind === 'memory' ? '作为 Memory 建议重新核对' : '恢复为正文草稿'}</Button>}<Button disabled={locked} onClick={() => setContextView({ title: '历史请求上下文', context: artifact.context })}>查看当时上下文</Button><pre>{artifact.content ?? artifact.replacement ?? artifact.memory ?? JSON.stringify(artifact.preparation ?? artifact.review, null, 2)}</pre></section>}
    </Drawer>
    <Modal title={expanded === 'memory' ? 'Memory · 全书记忆' : '作者批注 · 本章'} open={Boolean(expanded)} footer={<Button onClick={() => setExpanded(null)}>完成编辑</Button>} onCancel={() => setExpanded(null)} width={760}>
      <Input.TextArea aria-label={expanded === 'memory' ? '展开编辑 Memory' : '展开编辑作者批注'} rows={16} disabled={locked} maxLength={expanded === 'memory' ? 100000 : 20000} value={expanded === 'memory' ? settings?.memory : chapter.author_note} onChange={event => expanded === 'memory' ? editSettings({ memory: event.target.value }) : editChapter({ author_note: event.target.value })} />
      <p className="panel-footnote">{expanded === 'memory' ? 'Memory 属于项目设置，点击顶部「保存修改」后保存。' : '作者批注随本章独立保存，停止编辑 3 秒后自动保存。'}</p>
    </Modal>
    <Modal title="导入设定" open={Boolean(importedLore)} onCancel={() => setImportedLore(null)} footer={<><Button onClick={() => setImportedLore(null)}>取消</Button><Button onClick={() => finishImport(true)}>替换现有设定</Button><Button type="primary" onClick={() => finishImport(false)}>合并到现有设定</Button></>}>
      <p>读取到 {importedLore?.length ?? 0} 个条目。合并时保留现有条目；替换将移除编辑区内的现有设定。点击保存前不会改动已保存内容。</p>
    </Modal>
    <Modal title="编辑设定条目" open={Boolean(loreEdit)} okText="完成编辑" cancelText="取消" onOk={saveLore} onCancel={() => { if (!locked) { setLoreEdit(null); setLorePolish(null) } }} width={620} destroyOnClose maskClosable={!locked && !lorePolish} closable={!locked && !lorePolish} okButtonProps={{disabled: locked || Boolean(lorePolish)}} cancelButtonProps={{disabled: locked || Boolean(lorePolish)}}>
      {loreEdit && <fieldset className="modal-form lore-edit-form" disabled={locked || Boolean(lorePolish)}><label>条目名称<Input aria-label="条目名称" maxLength={500} value={loreEdit.title} onChange={event => setLoreEdit({ ...loreEdit, title: event.target.value })} /></label><label>分类<Input aria-label="设定分类" maxLength={200} placeholder="例如：人物、地点、世界规则" value={loreEdit.category} onChange={event => setLoreEdit({ ...loreEdit, category: event.target.value })} /></label><label>设定正文<Input.TextArea aria-label="设定正文" maxLength={50000} rows={8} value={loreEdit.text} onChange={event => setLoreEdit({ ...loreEdit, text: event.target.value })} /></label><div className="lore-polish-actions"><Button icon={<BulbOutlined />} disabled={locked || !loreEdit.text.trim() || !loreEdit.title.trim()} loading={busy === '正在整理润色设定'} onClick={polishLore}>AI 整理润色</Button><span className="panel-footnote">{models.find(model => model.id === settings?.model_id)?.name || '请先选择创作模型'} · 保留事实，先预览再采纳</span></div><label>触发词<Input.TextArea aria-label="设定触发词" rows={2} value={loreEdit.keys.join('\n')} placeholder="每行一个关键词，例如人物的全名、称呼" onChange={event => setLoreEdit({ ...loreEdit, keys: event.target.value.split('\n') })} /></label><div className="modal-toggles"><label>启用 <Switch checked={loreEdit.enabled} onChange={enabled => setLoreEdit({ ...loreEdit, enabled })} /></label><label>始终带入 <Switch checked={loreEdit.always_on} onChange={always_on => setLoreEdit({ ...loreEdit, always_on })} /></label>{settings?.lorebook.some(entry => entry.id === loreEdit.id) && <Popconfirm title="删除此设定条目？" description="保存前可重新打开项目恢复已保存版本。" okText="删除" cancelText="取消" onConfirm={() => { editSettings({ lorebook: settings.lorebook.filter(entry => entry.id !== loreEdit.id) }); setLoreEdit(null) }}><Button danger type="text" icon={<DeleteOutlined />}>删除</Button></Popconfirm>}</div><p className="panel-footnote">点击「完成编辑」后仍需保存修改。设定名称也应在正文里写明。</p></fieldset>}
    </Modal>
    <Modal title="设定整理润色 · 对比确认" open={Boolean(lorePolish)} width={920} onCancel={() => setLorePolish(null)} onOk={acceptLorePolish} okText="采纳到条目编辑区" cancelText="保留原文" okButtonProps={{disabled: locked || !lorePolish?.text.trim()}}>
      {lorePolish && <><p className="modal-description">{lorePolish.model} · 只整理当前条目的正文。请核对事实、限制条件和信息差，采纳后仍可继续编辑。</p><div className="comparison"><div><h4>原设定 · {proseLength(lorePolish.source.text)} 字</h4><pre>{lorePolish.source.text}</pre></div><div><h4>整理后 · {proseLength(lorePolish.text)} 字</h4><Input.TextArea aria-label="整理后的设定" rows={16} maxLength={50000} value={lorePolish.text} onChange={event => setLorePolish({...lorePolish, text: event.target.value})} /></div></div></>}
    </Modal>
    <Modal title="修改建议" open={Boolean(revision)} width={920} onCancel={() => setRevision(null)} onOk={acceptRevision} okText="接受并替换选段" cancelText="放弃建议" okButtonProps={{ disabled: locked || !revision?.replacement.trim() || (revisionIssues.length > 0 && !revisionAcknowledged) }}>
      {revision && <><p className="modal-description">右侧全部文字都会替换左侧选区，不包含只读上下文。可直接编辑右侧；接受后 3 秒自动保存。</p>
        <p>本次要求：{revision.instruction}</p>
        {revisionIssues.length > 0 && <Alert type="warning" showIcon message="修改建议可能超出要求，请先核对" description={<ul>{revisionIssues.map(issue => <li key={issue}>{issue}</li>)}</ul>} />}
        <div className="comparison"><div><h4>原选区 · {proseLength(revision.selected)} 字</h4><pre>{revision.selected}</pre></div><div><h4>替换文字 · {proseLength(revision.replacement)} 字（全部替换）</h4><Input.TextArea aria-label="修改后的选段" rows={8} maxLength={100000} value={revision.replacement} onChange={event => { setRevisionAcknowledged(false); setRevision({ ...revision, replacement: event.target.value }) }} /></div></div>
        <section className="revision-preview" aria-label="替换后的衔接预览"><h4>替换后的衔接预览</h4><p className="modal-description">灰色为保留的前后文，金色为实际替换文字。前后各展示最多 200 字符；省略号仅表示预览截断。</p>
          <div className="revision-joined"><span className="revision-neighbor">{Array.from(revision.before).length > 200 ? '…' : ''}{Array.from(revision.before).slice(-200).join('')}</span><mark>{revision.replacement}</mark><span className="revision-neighbor">{Array.from(revision.after).slice(0, 200).join('')}{Array.from(revision.after).length > 200 ? '…' : ''}</span></div>
        </section>
        {revisionIssues.length > 0 && <Checkbox checked={revisionAcknowledged} onChange={event => setRevisionAcknowledged(event.target.checked)}>我已核对上述提示和衔接，仍要替换</Checkbox>}</>}
    </Modal>
    <Modal title={memoryDraft?.finalize ? `第 ${memoryDraft.chapter_idx} 章 · 自动整理 Memory 并定稿` : '更新 Memory'} open={Boolean(memoryDraft)} width={920} closable={!locked} maskClosable={!locked} onCancel={() => !locked && setMemoryDraft(null)} okText={memoryDraft?.finalize ? '更新 Memory 并定稿' : '确认并保存 Memory'} cancelText={memoryDraft?.finalize ? '取消定稿' : '保留原记忆'} confirmLoading={locked} cancelButtonProps={{ disabled: locked }} onOk={() => {
      if (!settings || !memoryDraft) return
      if (memoryDraft.chapter_idx !== chapterIdx || memoryDraft.content !== chapter.content || memoryDraft.original !== settings.memory || (memoryDraft.finalize && dirty)) { notice.error('正文或原记忆已变化，请重新整理记忆建议'); return }
      return run(memoryDraft.finalize ? '正在更新 Memory 并定稿' : '正在保存 Memory', async () => {
        if (memoryDraft.finalize) {
          const result = await deskApi<{settings: Settings; chapter: Chapter}>(`/chapter/${chapterIdx}/finalize`, {confirmed: true, ...memoryDraft.finalize, memory: memoryDraft.proposed})
          setSettings(result.settings); setBaseSettings(result.settings); setChapter(result.chapter); setBaseChapter(result.chapter)
          setChapters(list => list.map(item => item.chapter_idx === chapterIdx ? {...item, status: 'finalized'} : item))
        } else await persistSettings({ ...settings, memory: memoryDraft.proposed, memory_through_chapter: memoryDraft.chapter_idx })
        setMemoryDraft(null); notice.success(memoryDraft.finalize ? 'Memory 已更新，本章已定稿并保存历史快照' : 'Memory 已更新并保存')
      })
    }}>
      {memoryDraft && <><p className="modal-description">{memoryDraft.finalize ? '已根据当前 Memory 与本章已保存正文自动整理。请核对并编辑建议；确认后同时更新全书 Memory、完成本章定稿并保存历史。取消不会改动记忆或定稿状态。' : '请核对已发生事实与人物知情范围。确认会保存右侧建议及当前全书设定；不会自动改写人物条目。'}</p>{!memoryDraft.proposed.trim() && <Alert type="warning" showIcon message="建议 Memory 为空，确认后将以空记忆保存，请核对。" />}<div className="comparison"><div><h4>原记忆</h4><pre>{memoryDraft.original || '尚无记忆'}</pre></div><div><h4>建议记忆 · 可编辑</h4><Input.TextArea aria-label="建议记忆" rows={15} maxLength={100000} disabled={locked} value={memoryDraft.proposed} onChange={event => setMemoryDraft({ ...memoryDraft, proposed: event.target.value })} /></div></div></>}
    </Modal>
    <Drawer title={contextView?.title || '上下文'} open={Boolean(contextView)} onClose={() => setContextView(null)} width={800} className="context-drawer">
      {contextView && <div className="context-details">{contextView.preview_mode && <section aria-label="上下文预览任务"><h3>预览任务</h3><div className="mode-options"><Button aria-pressed={contextView.preview_mode === 'write'} disabled={locked} type={contextView.preview_mode === 'write' ? 'primary' : 'default'} onClick={() => preview('write')}>整章生成</Button><Button aria-pressed={contextView.preview_mode === 'continue'} disabled={locked} type={contextView.preview_mode === 'continue' ? 'primary' : 'default'} onClick={() => preview('continue')}>继续写</Button></div><p className="panel-footnote">切换后刷新下方预览；NovelAI 会请求 token 计数，不生成正文。</p></section>}<div className="context-summary"><Tag>{contextView.context.chars.toLocaleString()} 字符</Tag>{contextView.context.model && <Tag>{contextView.context.model.name} · {contextView.context.model.model}</Tag>}<span>前章：{contextView.context.recent_sources.length ? contextView.context.recent_sources.join('、') : '未带入'}</span></div>{contextView.context.budget && <section aria-label="上下文容量预算"><h3>上下文预算 <Tag color={contextView.context.budget.blocked ? 'red' : 'green'}>{contextView.context.budget.blocked ? '必要内容超限 · 不会发送' : '预算内'}</Tag></h3><p className="panel-footnote">输入估算 {contextView.context.budget.estimated_input_tokens.toLocaleString()} + 输出预留 {contextView.context.budget.output_tokens.toLocaleString()} + 消息余量 {contextView.context.budget.reserved_tokens} / 容量 {contextView.context.budget.context_tokens.toLocaleString()} tokens。{contextView.context.budget.method === 'novelai-token-count' ? '输入使用 NovelAI 官方 tokenizer 计数，另为消息格式预留余量。' : '输入按 UTF-8 字节数保守估算，非模型精确 token 计数。'}预算不足时先裁剪较远正文和辅助材料；必要内容放不下时停止调用。</p></section>}{contextView.context.warnings.map((warning, index) => <Alert key={index} type="warning" showIcon message={warning} />)}<p className="panel-footnote">模型同时收到系统提示词和用户提示词；以下分别展示，两部分共同组成请求。篇幅目标也会在整章生成与续写的“本次任务”中列出。</p>{contextView.context.lore_status && <section><h3>设定如何带入</h3><div className="lore-status-list">{contextView.context.lore_status.map(entry => <div key={entry.id}><span>{entry.title || entry.id}</span><Tag color={entry.included ? 'gold' : undefined}>{entry.included ? '已带入' : '未带入'}</Tag><small>{entry.reason}{entry.matched_source ? ` · ${entry.matched_source}` : ''}{entry.matched_key ? ` · ${entry.matched_key}` : ''}</small></div>)}</div></section>}<Collapse items={[{ key: 'system', label: '系统提示词（写作要求、文风与篇幅）', children: <pre>{contextView.context.system_prompt}</pre> }, ...contextView.context.blocks.map((block, index) => ({ key: `block-${index}`, label: `${block.label} · ${Array.from(block.text).length} 字符`, children: <pre>{block.text}</pre> })), { key: 'full', label: '用户提示词（设定、台本与本次任务）', children: <pre>{contextView.context.user_prompt}</pre> }]} /></div>}
    </Drawer>
  </ConfigProvider>
}
