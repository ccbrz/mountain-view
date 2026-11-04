import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  Alert,
  Button,
  Collapse,
  ConfigProvider,
  Dropdown,
  Empty,
  Input,
  Modal,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  message,
  theme,
} from 'antd'
import {
  BookOutlined,
  BugOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  EditOutlined,
  ExpandOutlined,
  EyeOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LoadingOutlined,
  PictureOutlined,
  SaveOutlined,
  SendOutlined,
  SettingOutlined,
  SkinOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { revisionWarnings } from '../utils/revisionWarnings'
import ChapterSidebar, { type ChapterAction } from './desk/ChapterSidebar'
import MemoryPanel from './desk/MemoryPanel'
import LorePanel from './desk/LorePanel'
import ParametersPanel from './desk/ParametersPanel'
import { LoreEditModal, LorePolishModal } from './desk/LoreEditModal'
import { RepairModal, RevisionModal } from './desk/ReviewDialogs'
import { MemoryDraftModal, MemoryHistoryDrawer, MemoryRestoreModal } from './desk/MemoryDialogs'
import { ContextDrawer, HistoryDrawer } from './desk/InspectDrawers'
import { PreparationNote, QualityNote } from './desk/ChapterChecks'
import {
  chapterText,
  emptyChapter,
  proseCountHint,
  proseLength,
  type Artifact,
  type Chapter,
  type ChapterItem,
  type CheckView,
  type ContextView,
  type HistoryItem,
  type LocalDraft,
  type LoreEntry,
  type MemoryDraft,
  type MemoryRestore,
  type MemoryVersion,
  type ModelProfile,
  type PreparationView,
  type Project,
  type RepairView,
  type Revision,
  type Selection,
  type Settings,
  type StoryContext,
  type WorkspaceTool,
} from './desk/types'
import './WritingDesk.css'

const SHORTCUTS = [
  { label: '润色', instruction: '保留情节与信息，润色这段文字，减少套话，以具体动作和对白表达。' },
  { label: '扩写', instruction: '保留情节与人物动机，补充有用的动作、对白与感官细节，将本段写得更充分。' },
  { label: '精简', instruction: '保留关键信息与情节，精简重复表达和过度修饰，让这段更紧凑。' },
]

type VisualTheme = 'dark' | 'dragon'
type GenerateResult = {
  content: string
  context: StoryContext
  incomplete: boolean
  finish_reason?: string
  segments?: number
  warnings?: string[]
}

export default function WritingDesk({
  novelId,
  novelTitle,
  refreshVersion,
  modelsVersion,
  onBack,
  onOpenTool,
  onDebug,
  onOutlineReview,
  onOutlineVersions,
}: {
  novelId: string
  novelTitle: string
  refreshVersion: number
  modelsVersion: number
  onBack: () => void
  onOpenTool: (tool: WorkspaceTool) => void
  onDebug: () => void
  onOutlineReview: (num: number) => void
  onOutlineVersions: (num: number) => void
}) {
  const { user } = useAuth()
  const draftKey = `mountain-view-writing-draft-v1:${user?.username}:${novelId}`
  const themeKey = `mountain-view-writing-theme-v1:${user?.username}`
  const [visualTheme, setVisualTheme] = useState<VisualTheme>(() => {
    try {
      return localStorage.getItem(themeKey) === 'dragon' ? 'dragon' : 'dark'
    } catch {
      return 'dark'
    }
  })
  async function deskApi<T>(path: string, body?: object): Promise<T> {
    try {
      const result = body
        ? await api.post(`/novels/${novelId}/writer${path}`, body)
        : await api.get(`/novels/${novelId}/writer${path}`)
      return result.data as T
    } catch (error: any) {
      throw new Error(error.response?.data?.message || error.message || '操作失败，编辑仍保留在页面中')
    }
  }
  const [notice, noticeHolder] = message.useMessage()
  const [modal, modalHolder] = Modal.useModal()

  const [settings, setSettings] = useState<Settings | null>(null)
  const [baseSettings, setBaseSettings] = useState<Settings | null>(null)
  const [writingTemplate, setWritingTemplate] = useState('')
  const [lengthRange, setLengthRange] = useState<{ min: number; max: number } | null>(null)
  const [chapters, setChapters] = useState<ChapterItem[]>([])
  const [models, setModels] = useState<ModelProfile[]>([])
  const [recovery, setRecovery] = useState<LocalDraft | null>(null)
  const [draftError, setDraftError] = useState('')
  const [chapterIdx, setChapterIdx] = useState(1)
  const [chapter, setChapter] = useState<Chapter>(emptyChapter)
  const [baseChapter, setBaseChapter] = useState<Chapter>(emptyChapter)
  const [busy, setBusy] = useState('正在打开写作台')
  const [chapterSaving, setChapterSaving] = useState(false)
  const [chapterSaveError, setChapterSaveError] = useState('')
  const [error, setError] = useState('')
  const [inspectorTab, setInspectorTab] = useState('memory')
  const [mobilePanel, setMobilePanel] = useState<'chapters' | 'settings' | null>(null)
  const [mode, setMode] = useState<'write' | 'continue'>('write')
  const [undo, setUndo] = useState<{ content: string; incomplete?: boolean }[]>([])

  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [memoryHistoryOpen, setMemoryHistoryOpen] = useState(false)
  const [memoryVersions, setMemoryVersions] = useState<MemoryVersion[]>([])
  const [memoryVersion, setMemoryVersion] = useState<MemoryVersion | null>(null)
  const [memoryRestore, setMemoryRestore] = useState<MemoryRestore | null>(null)
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft | null>(null)
  const [renaming, setRenaming] = useState<{ idx: number; base: Chapter; title: string } | null>(null)
  const [loreEdit, setLoreEdit] = useState<LoreEntry | null>(null)
  const [lorePolish, setLorePolish] = useState<{ source: LoreEntry; text: string; model: string } | null>(null)
  const [importedLore, setImportedLore] = useState<LoreEntry[] | null>(null)
  const [expanded, setExpanded] = useState<'memory' | 'author_note' | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [instruction, setInstruction] = useState('')
  const [revision, setRevision] = useState<Revision | null>(null)
  const [revisionAcknowledged, setRevisionAcknowledged] = useState(false)
  const [preparation, setPreparation] = useState<PreparationView | null>(null)
  const [quality, setQuality] = useState<CheckView | null>(null)
  const [repair, setRepair] = useState<RepairView | null>(null)
  const [contextView, setContextView] = useState<ContextView | null>(null)
  const [portraits, setPortraits] = useState<Record<string, string>>({})
  const [pendingPortraits, setPendingPortraits] = useState<Set<string>>(new Set())
  const portraitUrls = useRef<Record<string, string>>({})
  const [backgrounds, setBackgrounds] = useState<Record<number, string>>({})
  const [pendingBackgrounds, setPendingBackgrounds] = useState<Set<number>>(new Set())
  const backgroundUrls = useRef<Record<number, string>>({})

  const operation = useRef(0)
  const savingChapter = useRef<Promise<boolean> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [streaming, setStreaming] = useState(false)
  const followStream = useRef(true)
  const lastAutoScroll = useRef(0)
  const chapterDirty = chapterText(chapter) !== chapterText(baseChapter)
  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(baseSettings)
  const locked = Boolean(busy) || chapterSaving
  const dirty = chapterDirty || settingsDirty
  const navigationDisabled = locked || Boolean(recovery)
  const revisionIssues = revision ? revisionWarnings(revision) : []
  const proseChars = proseLength(chapter.content)
  const proseCount = proseChars.toLocaleString()
  const noModel = Boolean(settings && !settings.model_id)
  const lengthWarning =
    !lengthRange || !proseChars
      ? ''
      : proseChars < lengthRange.min
        ? `正文 ${proseCount} 字，低于目标 ${lengthRange.min}–${lengthRange.max} 字，还差至少 ${lengthRange.min - proseChars} 字。`
        : proseChars > lengthRange.max
          ? `正文 ${proseCount} 字，超出目标 ${lengthRange.min}–${lengthRange.max} 字 ${proseChars - lengthRange.max} 字。`
          : ''

  async function openProject(preferredChapter?: number) {
    const version = ++operation.current
    setBusy('正在打开写作台')
    setError('')
    try {
      const project = await deskApi<Project>('/project')
      const modelData = await deskApi<{ models: ModelProfile[] }>('/models')
      let draft: LocalDraft | null = null
      try {
        const value = preferredChapter === undefined ? JSON.parse(localStorage.getItem(draftKey) || 'null') : null
        if (
          value &&
          Number.isInteger(value.chapter_idx) &&
          value.chapter_idx > 0 &&
          value.chapter_idx <= 999999 &&
          typeof value.chapter?.content === 'string' &&
          typeof value.chapter.raw_script === 'string' &&
          value.settings &&
          value.base_settings &&
          value.base_chapter
        )
          draft = value
      } catch {
        setDraftError('浏览器草稿无法读取，请检查浏览器存储权限。服务器生成记录仍可在历史中找回。')
      }
      const idx =
        draft?.chapter_idx ??
        (project.chapters.some(item => item.chapter_idx === preferredChapter)
          ? preferredChapter!
          : (project.chapters[0]?.chapter_idx ?? 1))
      const loaded = await deskApi<Chapter>(`/chapter/${idx}`)
      if (version !== operation.current) return
      setLengthRange(project.length_range)
      setWritingTemplate(project.writing_template)
      setSettings(project.settings)
      setBaseSettings(project.settings)
      setModels(modelData.models)
      setRecovery(draft)
      void loadPortraits()
      void loadBackgrounds()
      setChapters(
        project.chapters.some(item => item.chapter_idx === idx)
          ? project.chapters
          : [...project.chapters, { chapter_idx: idx, title: loaded.title, has_content: Boolean(loaded.content) }],
      )
      setChapterIdx(idx)
      setChapter(loaded)
      setBaseChapter(loaded)
      setSelection(null)
      setUndo([])
      setChapterSaveError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '打开失败，请重试。')
    } finally {
      if (version === operation.current) setBusy('')
    }
  }

  useEffect(() => {
    if (modelsVersion)
      void deskApi<{ models: ModelProfile[] }>('/models')
        .then(data => setModels(data.models))
        .catch(report)
  }, [modelsVersion])
  useEffect(() => {
    void openProject()
    return () => {
      operation.current += 1
    }
  }, [])
  useEffect(() => {
    if (!refreshVersion) return
    if (dirty || locked || recovery) {
      setError('服务器中的作品已更新，当前编辑已保留。请刷新页面后选择恢复草稿或使用服务器版本。')
      return
    }
    void openProject(chapterIdx)
  }, [refreshVersion])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // Back up unsaved edits per account and book, so a closed tab can be recovered.
  useEffect(() => {
    if (!settings || !baseSettings || locked || recovery) return
    try {
      if (dirty)
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            chapter_idx: chapterIdx,
            chapter,
            base_chapter: baseChapter,
            settings,
            base_settings: baseSettings,
            saved_at: new Date().toISOString(),
          }),
        )
      else localStorage.removeItem(draftKey)
    } catch {
      setDraftError('浏览器无法备份当前编辑，请确认正文自动保存成功、设定已保存后再离开。AI 生成记录仍会保存在服务器。')
    }
  }, [chapter, baseChapter, settings, baseSettings, chapterIdx, dirty, locked, recovery])

  // Chapter fields autosave 3 seconds after the last edit.
  useEffect(() => {
    if (!chapterDirty || locked || recovery || chapterSaveError || !settings) return
    const timer = window.setTimeout(() => void saveChapter(), 3000)
    return () => window.clearTimeout(timer)
  }, [chapter, baseChapter, chapterIdx, chapterDirty, locked, recovery, chapterSaveError, settings])

  // ⌘/Ctrl+S saves settings and the current chapter immediately.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!locked && !recovery && settings) void saveAll(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function report(e: unknown) {
    setError(e instanceof Error ? e.message : '操作未完成，你的编辑仍保留在这里。')
  }
  function editChapter(values: Partial<Chapter>) {
    setChapter(current => ({ ...current, ...values }))
  }
  function editSettings(values: Partial<Settings>) {
    setSettings(current => (current ? { ...current, ...values } : current))
  }
  function requestBody(nextMode = mode) {
    return {
      incomplete: !!chapter.incomplete,
      chapter_idx: chapterIdx,
      raw_script: chapter.raw_script,
      title: chapter.title,
      author_note: chapter.author_note,
      content: chapter.content,
      settings,
      mode: nextMode,
    }
  }
  function pushUndo() {
    setUndo(values => [...values.slice(-29), { content: chapter.content, incomplete: chapter.incomplete }])
  }
  async function run(label: string, work: () => Promise<void>) {
    if (locked) return
    setBusy(label)
    setError('')
    try {
      await work()
      return true
    } catch (e) {
      report(e)
      return false
    } finally {
      setBusy('')
    }
  }
  function showContext(title: string, context: StoryContext) {
    setContextView({ title, context })
  }
  function focusModelSetting() {
    setInspectorTab('parameters')
    setMobilePanel('settings')
  }

  async function loadChapter(idx: number) {
    if (locked) return false
    if (idx === chapterIdx) return true
    if (chapterDirty && !(await saveChapter())) return false
    return await run('正在打开章节', async () => {
      const loaded = await deskApi<Chapter>(`/chapter/${idx}`)
      setChapterIdx(idx)
      setChapter(loaded)
      setBaseChapter(loaded)
      setChapterSaveError('')
      setSelection(null)
      setUndo([])
      setInstruction('')
      setMode('write')
      setMobilePanel(null)
      setChapters(list =>
        list.some(item => item.chapter_idx === idx)
          ? list
          : [
              ...list,
              { chapter_idx: idx, title: loaded.title || `第 ${idx} 章`, has_content: Boolean(loaded.content) },
            ].sort((a, b) => a.chapter_idx - b.chapter_idx),
      )
    })
  }
  async function persistSettings(next: Settings) {
    const saved = await deskApi<{ settings: Settings }>('/settings', {
      settings: next,
      base_settings: baseSettings,
      chapter_idx: chapterIdx,
    })
    setSettings(saved.settings)
    setBaseSettings(saved.settings)
  }
  async function saveChapter(next = chapter) {
    if (savingChapter.current) return savingChapter.current
    if (chapterText(next) === chapterText(baseChapter)) return true
    const version = operation.current
    const idx = chapterIdx
    const base = baseChapter
    setChapterSaving(true)
    setChapterSaveError('')
    const pending = (async () => {
      try {
        const saved = await deskApi<Chapter>('/save', {
          incomplete: !!next.incomplete,
          chapter_idx: idx,
          raw_script: next.raw_script,
          title: next.title,
          content: next.content,
          author_note: next.author_note,
          base_chapter: base,
          last_context: next.last_context,
        })
        if (version !== operation.current) return false
        // A late response must never replace edits made after this snapshot was sent.
        setChapter(current =>
          chapterText(current) === chapterText(next) ? saved : { ...current, id: saved.id, status: saved.status },
        )
        setBaseChapter(saved)
        setChapters(list =>
          list.map(item =>
            item.chapter_idx === idx
              ? {
                  ...item,
                  id: saved.id,
                  title: saved.title,
                  status: saved.status,
                  has_content: Boolean(saved.content.trim()),
                  word_count: saved.content.replace(/\s/g, '').length,
                }
              : item,
          ),
        )
        return true
      } catch (e) {
        if (version === operation.current)
          setChapterSaveError(e instanceof Error ? e.message : '正文自动保存失败，请重试')
        return false
      } finally {
        savingChapter.current = null
        if (version === operation.current) setChapterSaving(false)
      }
    })()
    savingChapter.current = pending
    return pending
  }
  async function saveAll(announce = false) {
    if (!settings) return false
    return run('正在保存', async () => {
      if (settingsDirty) await persistSettings(settings)
      if (!(await saveChapter())) throw new Error('本章未保存成功，请重试或处理版本冲突后再离开')
      if (announce) notice.success('已保存设定与本章')
    })
  }
  async function saveSettings() {
    if (!settings) return
    return run('正在保存设定', async () => {
      if (settingsDirty) await persistSettings(settings)
      notice.success('设定已保存；正文独立自动保存')
    })
  }
  async function openTool(action: () => void | Promise<void>) {
    if (navigationDisabled) return
    if (!dirty || (await saveAll())) {
      setMobilePanel(null)
      await action()
    }
  }
  async function backToLibrary() {
    if (navigationDisabled) return
    if (settingsDirty)
      modal.confirm({
        title: '保存设定后返回书架？',
        content: 'Memory、Lorebook 或写作参数尚未保存，离开前也会完成正文自动保存。',
        okText: '保存并返回',
        cancelText: '继续写作',
        onOk: async () => {
          if (await saveAll()) onBack()
          else throw new Error('保存失败，请留在写作台重试')
        },
      })
    else if (await saveChapter()) onBack()
  }

  /**
   * Streams generation over SSE so prose appears as it is written. Deltas only drive a preview; the final
   * `done` event carries the server's authoritative result, which then goes through the normal save path.
   */
  async function streamGenerate(body: object): Promise<GenerateResult> {
    const token = localStorage.getItem('token')
    const response = await fetch(`/api/novels/${novelId}/writer/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ...body, stream: true }),
    })
    if (response.status === 401) {
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.message || '生成失败，编辑仍保留在页面中')
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return await response.json()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    let preview = ''
    let frame = 0
    let result: GenerateResult | undefined
    let status = '正在生成正文'
    const flush = () => {
      frame = 0
      const el = scrollRef.current
      setChapter(current => ({ ...current, content: preview }))
      setBusy(`${status} · 已写 ${proseLength(preview).toLocaleString()} 字`)
      if (el && followStream.current)
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight
          lastAutoScroll.current = el.scrollTop
        })
    }
    const apply = (event: any) => {
      if (event.type === 'start') {
        preview = event.base
        followStream.current = true
        setStreaming(true)
      } else if (event.type === 'delta') preview += event.text
      else if (event.type === 'segment') {
        preview += event.separator
        status = event.status
      } else if (event.type === 'status') status = event.status
      else if (event.type === 'done') result = event.result
      else if (event.type === 'error') throw new Error(event.message)
      if (!frame) frame = requestAnimationFrame(flush)
    }
    for (;;) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      const blocks = pending.split('\n\n')
      pending = done ? '' : blocks.pop()!
      for (const block of blocks)
        for (const line of block.split('\n')) if (line.startsWith('data:')) apply(JSON.parse(line.slice(5)))
      if (done) break
    }
    if (frame) cancelAnimationFrame(frame)
    if (!result) throw new Error('生成连接中断，结果未返回；正文保持原样，请重试')
    return result
  }

  async function generate(nextMode: 'write' | 'continue') {
    if (!chapter.raw_script.trim()) return void notice.warning('请先填写本章台本')
    if (noModel) return void focusModelSetting()
    if (
      settings?.memory.trim() &&
      (settings.memory_through_chapter === undefined ||
        (nextMode === 'write'
          ? settings.memory_through_chapter >= chapterIdx
          : settings.memory_through_chapter > chapterIdx))
    ) {
      await previewMemoryRestore()
      return
    }
    const generateNow = () =>
      run(nextMode === 'write' ? '正在将台本写成正文' : '正在继续写', async () => {
        setMode(nextMode)
        setQuality(null)
        setRepair(null)
        setBusy('写前核对：本章起点、事实与知情边界')
        const source = requestBody(nextMode)
        const prepared = await deskApi<PreparationView>('/prepare', source)
        setPreparation({ ...prepared, chapter_idx: chapterIdx, source: JSON.stringify(source) })
        setChapter(current => ({ ...current, last_context: prepared.context }))
        if (prepared.preparation.conflicts.length) {
          setError('写前发现材料冲突，请先按下方原句核对 Memory、台本或设定，再生成。正文和 Memory 均未修改。')
          return
        }
        setBusy('正在按台本生成正文')
        setBusy('正在按台本生成正文')
        let result: GenerateResult
        try {
          result = await streamGenerate({ ...source, prepared_id: prepared.artifact_id })
        } catch (e) {
          // The live preview is not the manuscript: put the editor back exactly as it was.
          setChapter(current => ({ ...current, content: chapter.content, incomplete: chapter.incomplete }))
          throw e
        } finally {
          setStreaming(false)
        }
        const next = {
          ...chapter,
          content: result.content,
          last_context: result.context,
          incomplete: result.incomplete,
        }
        pushUndo()
        setChapter(next)
        setSelection(null)
        setMode(nextMode)
        const saved = await saveChapter(next)
        if (result.warnings?.length) setError(result.warnings.join('\n'))
        else if ((result.segments || 1) > 1) notice.info(`本章已自动分 ${result.segments} 段生成完成`)
        if (result.incomplete)
          notice.warning(
            result.finish_reason === 'stream_cut'
              ? `模型响应在约 110 秒时被服务端断开，已保留收到的 ${proseLength(result.content).toLocaleString()} 字，可点「继续写」接上`
              : '达到单次输出上限，已保留未完成草稿，请继续写或手工补全',
          )
        // Refinement is author-initiated: a long diagnosis can exceed NovelAI's ~110 s response cap.
        else if (saved)
          notice.success(
            `正文已生成并自动保存，共 ${proseLength(result.content).toLocaleString()} 字；需要时可点「全文精修」`,
          )
      })
    if (nextMode === 'write' && chapter.content.trim())
      modal.confirm({
        title: '重新生成本章草稿？',
        content: '新正文生成后会自动保存。原有已保存正文保留修订记录，也可以用「撤销」恢复编辑前的内容。',
        okText: '生成新草稿',
        cancelText: '取消',
        // Close right away: progress shows in the editor, not behind a blocking dialog.
        onOk: () => void generateNow(),
      })
    else await generateNow()
  }
  async function refineProse(next = chapter, nextMode = mode) {
    setBusy('全文精修：三层诊断 → 定点改稿 → 候选复核')
    const source = {
      ...requestBody(nextMode),
      content: next.content,
      incomplete: !!next.incomplete,
      title: next.title,
      raw_script: next.raw_script,
      author_note: next.author_note,
    }
    const result = await deskApi<RepairView>('/refine', source)
    setRepair({ ...result, source: JSON.stringify(source) })
    if (result.diagnosis && result.length)
      setQuality({
        artifact_id: result.artifact_id,
        review: result.diagnosis,
        length: result.length,
        context: result.contexts?.diagnosis || result.context,
        chapter_idx: chapterIdx,
        source: JSON.stringify(source),
      })
    setChapter(current => (current.content === next.content ? { ...current, last_context: result.context } : current))
  }
  const qualityCurrent = quality?.chapter_idx === chapterIdx && quality.source === JSON.stringify(requestBody())
  async function suggestRepair() {
    await run('正在全文精修', async () => {
      if (!(await saveChapter())) throw new Error('本章尚未保存成功，请重试')
      await refineProse()
    })
  }
  async function acceptRepair() {
    if (!repair || repair.source !== JSON.stringify(requestBody()))
      return void notice.warning('正文或设定已变化，请重新进行全文精修')
    const candidate = repair
    await run('正在保存已复核的修订', async () => {
      pushUndo()
      const next = { ...chapter, content: candidate.content, last_context: candidate.context }
      setChapter(next)
      setRepair(null)
      setSelection(null)
      setQuality(null)
      if (!(await saveChapter(next))) throw new Error('修订留在编辑区，自动保存失败，请重试保存')
      notice.success('已采用通过复核的修改；仍需作者决定的问题请继续核对')
    })
  }
  async function revise() {
    if (!selection || !instruction.trim()) return
    if (
      selection.chapter_idx !== chapterIdx ||
      selection.before + selection.selected + selection.after !== chapter.content
    ) {
      setSelection(null)
      return void notice.warning('正文已变化，请重新选择要修改的文字')
    }
    await run('正在修改选中段落', async () => {
      const result = await deskApi<{ replacement: string; context: StoryContext }>('/revise', {
        ...requestBody(),
        ...selection,
        instruction,
      })
      setRevisionAcknowledged(false)
      setRevision({ ...selection, ...result, instruction })
      editChapter({ last_context: result.context })
    })
  }
  function acceptRevision() {
    if (!revision || (revisionIssues.length > 0 && !revisionAcknowledged)) return
    if (revision.chapter_idx !== chapterIdx || chapter.content !== revision.before + revision.selected + revision.after)
      return void notice.error('原文已变化，这份修改没有应用。请重新选段。')
    pushUndo()
    editChapter({ content: revision.before + revision.replacement + revision.after, last_context: revision.context })
    setRevision(null)
    setSelection(null)
    setInstruction('')
    notice.success('已替换选中段落，3 秒后自动保存；可撤销')
  }

  async function suggestMemory(finalize = false) {
    if (!settings) return
    if (
      settings.memory.trim() &&
      (settings.memory_through_chapter === undefined || settings.memory_through_chapter >= chapterIdx)
    ) {
      await previewMemoryRestore()
      return
    }
    await run(finalize ? '正在为定稿整理 Memory' : '正在整理本章记忆建议', async () => {
      const result = await deskApi<{ memory: string; context: StoryContext }>('/memory/suggest', requestBody())
      setMemoryDraft({
        original: settings.memory,
        proposed: result.memory,
        content: chapter.content,
        chapter_idx: chapterIdx,
        ...(finalize ? { finalize: { base_chapter: baseChapter, base_settings: baseSettings! } } : {}),
      })
      editChapter({ last_context: result.context })
    })
  }
  async function confirmMemoryDraft() {
    if (!settings || !memoryDraft) return
    if (
      memoryDraft.chapter_idx !== chapterIdx ||
      memoryDraft.content !== chapter.content ||
      memoryDraft.original !== settings.memory ||
      (memoryDraft.finalize && dirty)
    )
      return void notice.error('正文或原记忆已变化，请重新整理记忆建议')
    return run(memoryDraft.finalize ? '正在更新 Memory 并定稿' : '正在保存 Memory', async () => {
      if (memoryDraft.finalize) {
        const result = await deskApi<{ settings: Settings; chapter: Chapter }>(`/chapter/${chapterIdx}/finalize`, {
          confirmed: true,
          ...memoryDraft.finalize,
          memory: memoryDraft.proposed,
        })
        setSettings(result.settings)
        setBaseSettings(result.settings)
        setChapter(result.chapter)
        setBaseChapter(result.chapter)
        setChapters(list =>
          list.map(item => (item.chapter_idx === chapterIdx ? { ...item, status: 'finalized' } : item)),
        )
      } else
        await persistSettings({
          ...settings,
          memory: memoryDraft.proposed,
          memory_through_chapter: memoryDraft.chapter_idx,
        })
      setMemoryDraft(null)
      notice.success(memoryDraft.finalize ? 'Memory 已更新，本章已定稿并保存历史快照' : 'Memory 已更新并保存')
    })
  }
  async function previewMemoryRestore(version?: number) {
    if (!settings || !baseSettings) return
    await run('正在准备本章开始前的记忆', async () => {
      if (!(await saveChapter())) throw new Error('本章尚未保存成功，请重试')
      const result = await deskApi<Omit<MemoryRestore, 'settings' | 'base_settings'>>(
        version === undefined ? `/memory/before/${chapterIdx}` : `/memory/history/${version}`,
      )
      setMemoryRestore({ ...result, settings, base_settings: baseSettings })
    })
  }
  async function restoreMemory() {
    if (!memoryRestore?.restorable) return
    await run('正在备份并恢复 Memory', async () => {
      const result = await deskApi<{ settings: Settings }>('/memory/restore', {
        version_id: memoryRestore.id,
        target_chapter: memoryRestore.target_chapter,
        context_revision: memoryRestore.context_revision,
        settings: memoryRestore.settings,
        base_settings: memoryRestore.base_settings,
      })
      setSettings(result.settings)
      setBaseSettings(result.settings)
      setMemoryRestore(null)
      setMemoryHistoryOpen(false)
      setPreparation(null)
      setQuality(null)
      setRepair(null)
      notice.success('记忆已恢复，原版本已备份；现在可以重写本章')
    })
  }
  async function showMemoryHistory() {
    await run('正在读取记忆历史', async () => {
      const result = await deskApi<{ items: MemoryVersion[] }>('/memory/history')
      setMemoryVersions(result.items)
      setMemoryVersion(
        result.items.length ? await deskApi<MemoryVersion>(`/memory/history/${result.items[0].id}`) : null,
      )
      setMemoryHistoryOpen(true)
      setMobilePanel(null)
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
      setHistory(result.items)
      setArtifact(null)
      setHistoryOpen(true)
    })
  }
  function restoreArtifact() {
    if (!artifact || !settings) return
    if (artifact.kind === 'memory') {
      if (
        chapterDirty ||
        artifact.source.content !== chapter.content ||
        artifact.source.settings.memory !== settings.memory
      )
        return void notice.warning('这份建议对应的正文或原记忆已经变化，请根据当前定稿重新整理')
      setMemoryDraft({
        original: settings.memory,
        proposed: artifact.memory || '',
        content: chapter.content,
        chapter_idx: chapterIdx,
      })
      setHistoryOpen(false)
      return
    }
    const item = artifact
    modal.confirm({
      title: '恢复这份生成草稿？',
      content: '会替换本章正文、台本和作者批注并自动保存。全书 Memory 和设定保持当前版本；可撤销正文修改。',
      okText: '恢复到编辑区',
      cancelText: '取消',
      onOk: () => {
        const content =
          item.kind === 'revise'
            ? (item.source.before || '') + (item.replacement || '') + (item.source.after || '')
            : item.content || ''
        pushUndo()
        editChapter({
          raw_script: item.source.raw_script,
          title: item.source.title,
          author_note: item.source.author_note,
          content,
          incomplete: item.kind === 'revise' ? !!item.source.incomplete : !!item.incomplete,
          last_context: item.context,
        })
        setSelection(null)
        setHistoryOpen(false)
        notice.success('已恢复到编辑区，3 秒后自动保存')
      },
    })
  }
  function downloadBook(format: 'txt' | 'md' | 'json') {
    const download = () =>
      run('正在准备下载', async () => {
        const response = await api.get(`/novels/${novelId}/writer/download?format=${format}`, { responseType: 'blob' })
        const url = URL.createObjectURL(response.data)
        const link = document.createElement('a')
        link.href = url
        link.download = format === 'json' ? `${novelTitle}-backup.json` : `${novelTitle}.${format}`
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
    if (settingsDirty)
      modal.confirm({
        title: '保存设定后下载？',
        content: '保存当前设定，并在导出前完成正文自动保存。',
        okText: '保存并下载',
        cancelText: '取消',
        onOk: async () => {
          if (await saveAll()) await download()
        },
      })
    else void saveChapter().then(saved => saved && void download())
  }

  function newChapter() {
    let idx = 1
    while (chapters.some(item => item.chapter_idx === idx)) idx += 1
    void loadChapter(idx)
  }
  async function chapterAction(item: ChapterItem, action: ChapterAction) {
    await openTool(async () => {
      if (action === 'versions') return onOutlineVersions(item.chapter_idx)
      if (action === 'background') return void generateBackground(item.chapter_idx)
      if (action === 'rename') {
        await run('正在读取章节', async () => {
          const base = await deskApi<Chapter>(`/chapter/${item.chapter_idx}`)
          setRenaming({ idx: item.chapter_idx, base, title: base.title })
        })
        return
      }
      modal.confirm({
        title: `删除第 ${item.chapter_idx} 章「${item.title || '未命名章节'}」？`,
        content: '本章正文、台本及相关生成和修订记录将被删除。请先导出需要保留的内容。',
        okText: '删除章节',
        okType: 'danger',
        cancelText: '取消',
        onOk: () =>
          run('正在删除章节', async () => {
            const target = await deskApi<Chapter>(`/chapter/${item.chapter_idx}`)
            if (target.id) await api.delete(`/novels/${novelId}/chapters/${target.id}`)
            await openProject(chapterIdx === item.chapter_idx ? undefined : chapterIdx)
            notice.success('章节已删除')
          }),
      })
    })
  }
  async function renameChapter() {
    if (!renaming?.title.trim()) return void notice.warning('请填写章节标题')
    await run('正在重命名章节', async () => {
      const saved = await deskApi<Chapter>('/save', {
        ...renaming.base,
        chapter_idx: renaming.idx,
        title: renaming.title.trim(),
        base_chapter: renaming.base,
      })
      if (renaming.idx === chapterIdx) {
        setChapter(saved)
        setBaseChapter(saved)
      }
      setChapters(list =>
        list.map(item => (item.chapter_idx === renaming.idx ? { ...item, id: saved.id, title: saved.title } : item)),
      )
      setRenaming(null)
      notice.success('章节已重命名')
    })
  }

  async function importLore(file: File) {
    try {
      if (file.size > 300000) throw new Error('设定文件过大，请使用 300 KB 以内的 JSON 文件')
      const data: unknown = JSON.parse(await file.text())
      const valid = (entry: any) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        entry.id.length <= 200 &&
        typeof entry.title === 'string' &&
        entry.title.length <= 500 &&
        typeof entry.text === 'string' &&
        entry.text.length <= 50000 &&
        Array.isArray(entry.keys) &&
        entry.keys.length <= 100 &&
        entry.keys.every((key: unknown) => typeof key === 'string' && key.length <= 500) &&
        typeof entry.enabled === 'boolean' &&
        typeof entry.always_on === 'boolean' &&
        typeof entry.category === 'string' &&
        entry.category.length <= 200
      if (!Array.isArray(data) || data.length > 500 || !data.every(valid))
        throw new Error('请导入本工具导出的 Lorebook JSON，条目结构不完整')
      if (new Set(data.map(entry => entry.id)).size !== data.length)
        throw new Error('文件中的条目 ID 重复，请检查后重试')
      setImportedLore(
        data.map(entry => ({
          id: entry.id,
          title: entry.title,
          text: entry.text,
          keys: entry.keys,
          enabled: entry.enabled,
          always_on: entry.always_on,
          category: entry.category,
        })),
      )
    } catch (e) {
      report(e)
    }
  }
  function exportLore() {
    if (!settings) return
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(settings.lorebook, null, 2)], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `${novelTitle}-lorebook.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function finishImport(replace: boolean) {
    if (!settings || !importedLore) return
    const merged = replace
      ? importedLore
      : [
          ...settings.lorebook,
          ...importedLore.map(entry => ({
            ...entry,
            id: settings.lorebook.some(old => old.id === entry.id) ? crypto.randomUUID() : entry.id,
          })),
        ]
    if (merged.length > 500) return void notice.warning('合并后超过 500 个条目，请精简后导入')
    editSettings({ lorebook: merged })
    setImportedLore(null)
    notice.success('设定已导入编辑区，保存后生效')
  }
  async function polishLore() {
    if (!loreEdit?.title.trim() || !loreEdit.text.trim()) return void notice.warning('请填写条目名称和设定正文')
    if (!(settings?.lore_model_id || settings?.model_id))
      return void notice.warning('请先选择设定生成模型，或在参数中选择创作模型')
    const source = { ...loreEdit }
    await run('正在整理润色设定', async () => {
      const result = await deskApi<{ text: string; context: StoryContext }>('/lore/polish', {
        ...requestBody(),
        lore_entry: source,
      })
      setLorePolish({ source, text: result.text, model: result.context.model?.name || '设定生成模型' })
    })
  }
  function acceptLorePolish() {
    if (!lorePolish || !loreEdit || locked) return
    if (JSON.stringify(loreEdit) !== JSON.stringify(lorePolish.source))
      return void notice.warning('条目已变化，请根据当前内容重新整理')
    setLoreEdit({ ...loreEdit, text: lorePolish.text })
    setLorePolish(null)
    notice.success('已采纳到条目编辑区，完成编辑后保存设定')
  }
  function saveLore(cleaned: LoreEntry) {
    if (!settings) return
    const lorebook = settings.lorebook.some(entry => entry.id === cleaned.id)
      ? settings.lorebook.map(entry => (entry.id === cleaned.id ? cleaned : entry))
      : [...settings.lorebook, cleaned]
    editSettings({ lorebook })
    setLoreEdit(null)
  }

  async function fetchPortrait(entryId: string) {
    const response = await api.get(`/novels/${novelId}/writer/lore/portrait/${encodeURIComponent(entryId)}`, {
      responseType: 'blob',
    })
    const url = URL.createObjectURL(response.data)
    if (portraitUrls.current[entryId]) URL.revokeObjectURL(portraitUrls.current[entryId])
    portraitUrls.current[entryId] = url
    setPortraits(current => ({ ...current, [entryId]: url }))
  }
  async function loadPortraits() {
    try {
      const { items } = await deskApi<{ items: { entry_id: string }[] }>('/lore/portraits')
      await Promise.all(
        items.filter(item => !portraitUrls.current[item.entry_id]).map(item => fetchPortrait(item.entry_id)),
      )
    } catch {
      // Portraits are decorative; the desk works without them.
    }
  }
  /** Runs alongside writing: it never locks the desk, and failures only leave the previous image in place. */
  async function generatePortrait(entry: LoreEntry) {
    if (!settings) return
    if (!settings.image_model_id) return void notice.info('请先在「设定」页底部选择生图模型')
    if (!entry.title.trim() || !entry.text.trim()) return void notice.warning('请先填写条目名称和设定正文')
    if (pendingPortraits.has(entry.id)) return
    const current = settings
    setPendingPortraits(set => new Set(set).add(entry.id))
    try {
      await deskApi('/lore/portrait', { settings: current, lore_entry: entry })
      await fetchPortrait(entry.id)
    } catch (e) {
      notice.warning(`「${entry.title}」的背景图未生成：${e instanceof Error ? e.message : '请稍后重试'}`)
    } finally {
      setPendingPortraits(set => {
        const next = new Set(set)
        next.delete(entry.id)
        return next
      })
    }
  }
  async function fetchBackground(idx: number) {
    const response = await api.get(`/novels/${novelId}/writer/chapter/${idx}/background`, { responseType: 'blob' })
    const url = URL.createObjectURL(response.data)
    if (backgroundUrls.current[idx]) URL.revokeObjectURL(backgroundUrls.current[idx])
    backgroundUrls.current[idx] = url
    setBackgrounds(current => ({ ...current, [idx]: url }))
  }
  /** Chapter numbers can be reused after a delete, so the map is rebuilt from the server each time. */
  async function loadBackgrounds() {
    try {
      const { items } = await deskApi<{ items: { chapter_idx: number }[] }>('/chapter-backgrounds')
      for (const url of Object.values(backgroundUrls.current)) URL.revokeObjectURL(url)
      backgroundUrls.current = {}
      setBackgrounds({})
      await Promise.all(items.map(item => fetchBackground(item.chapter_idx)))
    } catch {
      // Backgrounds are decorative; the desk works without them.
    }
  }
  /** Draws from the saved chapter; unsaved edits to the current chapter are saved first. Never locks the desk. */
  async function generateBackground(idx: number) {
    if (!settings?.image_model_id) {
      notice.info('请先在「设定」页底部选择生图模型')
      setInspectorTab('lore')
      setMobilePanel('settings')
      return
    }
    if (pendingBackgrounds.has(idx)) return
    if (idx === chapterIdx && chapterDirty && !(await saveChapter())) return
    setPendingBackgrounds(set => new Set(set).add(idx))
    try {
      await deskApi(`/chapter/${idx}/background`, { settings })
      await fetchBackground(idx)
      notice.success(`第 ${idx} 章背景图已生成`)
    } catch (e) {
      notice.warning(`第 ${idx} 章背景图未生成：${e instanceof Error ? e.message : '请稍后重试'}`)
    } finally {
      setPendingBackgrounds(set => {
        const next = new Set(set)
        next.delete(idx)
        return next
      })
    }
  }
  useEffect(
    () => () => {
      for (const url of Object.values(portraitUrls.current)) URL.revokeObjectURL(url)
      for (const url of Object.values(backgroundUrls.current)) URL.revokeObjectURL(url)
    },
    [],
  )

  const saveState = chapterSaveError
    ? { tone: 'error', label: '自动保存失败' }
    : locked && chapterSaving
      ? { tone: 'pending', label: '正在保存本章' }
      : chapterDirty
        ? { tone: 'pending', label: '等待自动保存' }
        : { tone: 'ok', label: '本章已保存' }
  const finalizeHint = chapter.incomplete
    ? '正文尚未完成，请继续写或手工补全后再定稿。'
    : dirty
      ? settingsDirty
        ? '请先保存设定，再定稿。'
        : '正在等待本章自动保存，再定稿。'
      : '定稿时自动整理 Memory，核对后一起保存。'
  const accent = visualTheme === 'dragon' ? '#d8ac69' : '#d6b97c'

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: accent,
          colorInfo: accent,
          colorBgBase: visualTheme === 'dragon' ? '#111b19' : '#121317',
        },
      }}
    >
      {noticeHolder}
      {modalHolder}
      <div className={`writing-app mv-writing-desk theme-${visualTheme}`}>
        {mobilePanel && (
          <button className="panel-backdrop mobile-only" aria-label="收起侧栏" onClick={() => setMobilePanel(null)} />
        )}

        <ChapterSidebar
          novelTitle={novelTitle}
          chapters={chapters}
          chapterIdx={chapterIdx}
          currentTitle={chapter.title}
          chapterDirty={chapterDirty}
          disabled={locked || !settings}
          navigationDisabled={navigationDisabled}
          mobileOpen={mobilePanel === 'chapters'}
          onCloseMobile={() => setMobilePanel(null)}
          onBack={backToLibrary}
          onOpenSettings={() => openTool(() => onOpenTool('settings'))}
          onNewChapter={newChapter}
          onSelect={idx => void loadChapter(idx)}
          onAction={(item, action) => void chapterAction(item, action)}
          onDownload={downloadBook}
          backgrounds={backgrounds}
          pendingBackgrounds={pendingBackgrounds}
        />

        <main className="manuscript-panel">
          {locked && <div className="busy-bar" role="progressbar" aria-label={busy || '正在保存'} />}
          <header className="editor-topbar">
            <div className="mobile-navigation mobile-only">
              <Button
                aria-label="打开章节目录"
                type="text"
                icon={<BookOutlined />}
                onClick={() => setMobilePanel('chapters')}
              />
              <Button
                aria-label="打开写作设置"
                type="text"
                icon={<SettingOutlined />}
                onClick={() => setMobilePanel('settings')}
              />
            </div>
            <div className="document-path">
              <FileTextOutlined />
              <span className="path-label">{novelTitle}</span>
              <span className="path-separator">/</span>
              <span>第 {chapterIdx} 章</span>
            </div>
            <div className="top-actions">
              <Dropdown
                trigger={['click']}
                disabled={locked || !settings}
                menu={{
                  items: [
                    { key: 'preview', icon: <EyeOutlined />, label: '本次上下文预览' },
                    { key: 'last', icon: <HistoryOutlined />, label: '上次实际请求', disabled: !chapter.last_context },
                    { type: 'divider' },
                    { key: 'debug', icon: <BugOutlined />, label: '模型调试与日志' },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'preview') void preview()
                    else if (key === 'last' && chapter.last_context) showContext('上次实际请求', chapter.last_context)
                    else if (key === 'debug') onDebug()
                  },
                }}
              >
                <Button type="text" icon={<EyeOutlined />}>
                  <span className="hide-narrow">AI 看到了什么</span>
                </Button>
              </Dropdown>
              <Button type="text" icon={<HistoryOutlined />} disabled={locked || !settings} onClick={showHistory}>
                <span className="hide-narrow">生成记录</span>
              </Button>
              <Dropdown
                trigger={['click']}
                menu={{
                  selectable: true,
                  selectedKeys: [visualTheme],
                  items: [
                    { key: 'dark', label: '经典深色' },
                    { key: 'dragon', label: '龙与地下城' },
                  ],
                  onClick: ({ key }) => {
                    setVisualTheme(key as VisualTheme)
                    try {
                      localStorage.setItem(themeKey, key)
                    } catch {
                      notice.warning('主题已切换，但浏览器无法记住偏好')
                    }
                  },
                }}
              >
                <Button type="text" aria-label="写作台主题" icon={<SkinOutlined />} />
              </Dropdown>
              <Tooltip title="保存 Memory、Lorebook 与写作参数（⌘/Ctrl + S）。正文、标题、台本和批注会自动保存。">
                <Button
                  type={settingsDirty ? 'primary' : 'default'}
                  icon={<SaveOutlined />}
                  disabled={locked || !settings || !settingsDirty}
                  onClick={saveSettings}
                >
                  {settingsDirty ? '保存设定' : '设定已保存'}
                </Button>
              </Tooltip>
            </div>
          </header>

          {error && (
            <div className="error-banner">
              <Alert
                type="error"
                showIcon
                closable
                onClose={() => setError('')}
                message={error}
                action={
                  !settings ? (
                    <Button size="small" onClick={() => openProject()} disabled={locked}>
                      重试
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )}
          {draftError && (
            <div className="error-banner">
              <Alert type="warning" showIcon message={draftError} />
            </div>
          )}

          {!settings ? (
            <div className="opening-state">
              {busy ? (
                <>
                  <Spin />
                  <p>正在打开你的写作空间…</p>
                </>
              ) : (
                <Empty description="暂时无法打开作品">
                  <Button onClick={() => openProject()}>重新打开</Button>
                </Empty>
              )}
            </div>
          ) : (
            <>
              <div
                className="manuscript-scroll"
                ref={scrollRef}
                onScroll={event => {
                  if (!streaming) return
                  // Scrolling up to reread pauses following; returning to the bottom resumes it.
                  const el = event.currentTarget
                  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) followStream.current = true
                  else if (el.scrollTop < lastAutoScroll.current - 40) followStream.current = false
                }}
              >
                <div className="manuscript-inner">
                  {noModel && (
                    <Alert
                      className="setup-banner"
                      type="info"
                      showIcon
                      message="还没有选择创作模型"
                      description="选择模型并保存设定后，就可以把台本生成正文。也可以先手写正文，所有内容都会自动保存。"
                      action={
                        <Button size="small" type="primary" onClick={focusModelSetting}>
                          选择模型
                        </Button>
                      }
                    />
                  )}
                  <div
                    className={`chapter-hero ${backgrounds[chapterIdx] ? 'has-background' : ''}`}
                    style={
                      backgrounds[chapterIdx]
                        ? ({ '--chapter-bg': `url(${backgrounds[chapterIdx]})` } as CSSProperties)
                        : undefined
                    }
                  >
                    <div className="chapter-eyebrow">
                      <span>第 {chapterIdx} 章</span>
                      <Tooltip
                        title={
                          settings.image_model_id
                            ? '根据已保存的标题、台本和开头正文生成本章背景图'
                            : '先在「设定」页底部选择生图模型'
                        }
                      >
                        <Button
                          type="text"
                          size="small"
                          icon={pendingBackgrounds.has(chapterIdx) ? <LoadingOutlined /> : <PictureOutlined />}
                          disabled={
                            pendingBackgrounds.has(chapterIdx) ||
                            (!chapter.raw_script.trim() && !chapter.content.trim())
                          }
                          onClick={() => void generateBackground(chapterIdx)}
                        >
                          {pendingBackgrounds.has(chapterIdx)
                            ? '正在生成背景图'
                            : backgrounds[chapterIdx]
                              ? '重新生成背景图'
                              : '生成背景图'}
                        </Button>
                      </Tooltip>
                    </div>
                    <input
                      className="chapter-title"
                      aria-label="章节标题"
                      placeholder="给这一章起个名字"
                      maxLength={500}
                      value={chapter.title}
                      disabled={locked}
                      onChange={event => editChapter({ title: event.target.value })}
                    />
                  </div>

                  <Collapse
                    className="script-collapse"
                    defaultActiveKey={['script']}
                    ghost
                    items={[
                      {
                        key: 'script',
                        label: (
                          <span className="script-label">
                            <FileTextOutlined /> 本章台本
                            <span className="quiet-label">
                              {chapter.raw_script.trim()
                                ? `${chapter.raw_script.split('\n').filter(line => line.trim()).length} 行`
                                : '你的剧情，由 AI 展开'}
                            </span>
                          </span>
                        ),
                        extra: (
                          <span className="script-tools" onClick={event => event.stopPropagation()}>
                            <Button
                              size="small"
                              type="text"
                              disabled={navigationDisabled}
                              onClick={() => openTool(() => onOutlineReview(chapterIdx))}
                            >
                              AI 整理台本
                            </Button>
                            <Button
                              size="small"
                              type="text"
                              disabled={navigationDisabled}
                              onClick={() => openTool(() => onOutlineVersions(chapterIdx))}
                            >
                              版本
                            </Button>
                          </span>
                        ),
                        children: (
                          <Input.TextArea
                            aria-label="本章完整台本"
                            disabled={locked}
                            autoSize={{ minRows: 4, maxRows: 14 }}
                            maxLength={100000}
                            value={chapter.raw_script}
                            placeholder="直接粘贴完整台本：事件顺序、关键对白和本章停在哪里。不需要拆场景。"
                            onChange={event => editChapter({ raw_script: event.target.value })}
                          />
                        ),
                      },
                    ]}
                  />

                  {preparation?.chapter_idx === chapterIdx && !preparation.preparation_warning && (
                    <PreparationNote preparation={preparation} onShowContext={showContext} />
                  )}

                  <section className="chapter-note" aria-label="本章作者批注">
                    <div className="section-heading">
                      <h3>
                        作者批注
                        <Tag bordered={false} className="quiet-tag">
                          仅本章
                        </Tag>
                      </h3>
                      <Tooltip title="展开编辑">
                        <Button
                          aria-label="展开作者批注"
                          type="text"
                          size="small"
                          icon={<ExpandOutlined />}
                          disabled={locked}
                          onClick={() => setExpanded('author_note')}
                        />
                      </Tooltip>
                    </div>
                    <Input.TextArea
                      aria-label="作者批注"
                      variant="borderless"
                      autoSize={{ minRows: 1, maxRows: 6 }}
                      disabled={locked}
                      maxLength={20000}
                      value={chapter.author_note}
                      placeholder="视角、语气与特别提醒。例如：第三人称有限视角；让关系通过动作和对白自然显现。"
                      onChange={event => editChapter({ author_note: event.target.value })}
                    />
                  </section>

                  <div className="prose-heading">
                    <Tooltip title={proseCountHint}>
                      <strong className="prose-count" aria-label={`正文字数：${proseCount} 字，含标点不含空白`}>
                        正文 · {proseCount} 字
                        {lengthRange && (
                          <small>
                            {' '}
                            / 目标 {lengthRange.min.toLocaleString()}–{lengthRange.max.toLocaleString()}
                          </small>
                        )}
                      </strong>
                    </Tooltip>
                    {lengthRange && (
                      <span className="length-meter" aria-hidden="true">
                        <span
                          className={proseChars > lengthRange.max ? 'over' : proseChars >= lengthRange.min ? 'ok' : ''}
                          style={{ width: `${Math.min(100, (proseChars / lengthRange.max) * 100)}%` }}
                        />
                      </span>
                    )}
                    <span className="prose-tip">选中文字可定向修改</span>
                  </div>

                  {chapterSaveError && (
                    <Alert
                      type="error"
                      showIcon
                      message="本章自动保存失败，当前编辑仍保留"
                      description={chapterSaveError}
                      action={
                        <Button disabled={locked} onClick={() => void saveChapter()}>
                          重试保存本章
                        </Button>
                      }
                    />
                  )}
                  {lengthWarning && !streaming && (
                    <Alert
                      type="warning"
                      showIcon
                      message={lengthWarning}
                      description={
                        proseChars < (lengthRange?.min || 0)
                          ? '台本未写完可点击「继续写」；已写完则补充现有情节细节，或选中文字要求扩写，保持原有剧情与章节落点。'
                          : '可以选中冗余段落要求精简，保留台本事件和关键线索。'
                      }
                    />
                  )}
                  {chapter.incomplete && (
                    <Alert
                      type="warning"
                      showIcon
                      message="正文未完成：生成达到单次输出上限"
                      description="已保留收到的正文。可以继续写，也可以手工补全；请核对台本是否全部落实后再定稿。"
                      action={
                        <div className="alert-actions">
                          <Button
                            size="small"
                            disabled={locked || !chapter.raw_script.trim()}
                            onClick={() => generate('continue')}
                          >
                            继续完成本章
                          </Button>
                          <Button
                            size="small"
                            disabled={locked}
                            onClick={() =>
                              modal.confirm({
                                title: '确认已手工补全正文？',
                                content: '请核对章节结尾与台本要求。确认后解除未完成标记，并自动保存。',
                                okText: '已核对并补全',
                                cancelText: '继续编辑',
                                onOk: () => editChapter({ incomplete: false }),
                              })
                            }
                          >
                            我已手工补全
                          </Button>
                        </div>
                      }
                    />
                  )}

                  <textarea
                    className={`prose-editor ${streaming ? 'streaming' : ''}`}
                    aria-label="小说正文"
                    value={chapter.content}
                    disabled={locked}
                    maxLength={500000}
                    spellCheck={false}
                    placeholder={
                      '故事从这里开始。\n\n写好台本后，点击「台本生成正文」。\n你可以直接改动文字，也可以选中一段，让 AI 按你的想法重写。'
                    }
                    onChange={event => {
                      editChapter({ content: event.target.value })
                      setSelection(null)
                    }}
                    onSelect={event => {
                      if (locked) return
                      const element = event.currentTarget
                      const start = element.selectionStart
                      const end = element.selectionEnd
                      if (start !== end)
                        setSelection({
                          chapter_idx: chapterIdx,
                          before: element.value.slice(0, start),
                          selected: element.value.slice(start, end),
                          after: element.value.slice(end),
                        })
                    }}
                  />

                  {quality?.chapter_idx === chapterIdx && (
                    <QualityNote quality={quality} current={qualityCurrent} onShowContext={showContext} />
                  )}

                  <section className="prose-actions" aria-label="正文审校与定稿">
                    <span>{finalizeHint}</span>
                    <div className="prose-action-buttons">
                      <Tooltip title="生成完成后会自动精修；修改正文、台本、批注或文风后，可手动再精修一次">
                        <Button
                          disabled={
                            locked ||
                            Boolean(recovery) ||
                            chapter.incomplete ||
                            !chapter.content.trim() ||
                            !chapter.raw_script.trim() ||
                            noModel
                          }
                          onClick={suggestRepair}
                        >
                          全文精修
                        </Button>
                      </Tooltip>
                      <Tooltip
                        title={
                          chapter.incomplete
                            ? '请先继续写或手工补全正文并保存'
                            : dirty
                              ? '先保存正文和设定，再整理记忆'
                              : '整理 Memory 建议，核对后更新记忆并定稿'
                        }
                      >
                        <Button
                          type="primary"
                          ghost
                          icon={<CheckCircleOutlined />}
                          disabled={locked || dirty || chapter.incomplete || !chapter.content.trim() || noModel}
                          onClick={() => suggestMemory(true)}
                        >
                          确认定稿
                        </Button>
                      </Tooltip>
                    </div>
                  </section>
                  <div className="manuscript-end">
                    <span />✦<span />
                  </div>
                </div>
              </div>

              {selection && (
                <div className="selection-bar">
                  <div className="selection-header">
                    <span>
                      <EditOutlined /> 修改选段 <small>{Array.from(selection.selected).length} 字符</small>
                    </span>
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      aria-label="取消选段"
                      disabled={locked}
                      onClick={() => setSelection(null)}
                    />
                  </div>
                  <div className="revision-shortcuts">
                    {SHORTCUTS.map(item => (
                      <button
                        key={item.label}
                        className={`lore-chip ${instruction === item.instruction ? 'active' : ''}`}
                        disabled={locked}
                        onClick={() => setInstruction(item.instruction)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <Input.TextArea
                    aria-label="选段修改要求"
                    placeholder="例如：保留剧情，让老赵更嘴硬，减少解释情绪的旁白。⌘/Ctrl + Enter 提交"
                    autoSize={{ minRows: 1, maxRows: 3 }}
                    maxLength={20000}
                    disabled={locked}
                    value={instruction}
                    onChange={event => setInstruction(event.target.value)}
                    onKeyDown={event => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void revise()
                      }
                    }}
                  />
                  <Button
                    type="primary"
                    disabled={locked || !instruction.trim() || noModel}
                    icon={<EditOutlined />}
                    onClick={revise}
                  >
                    生成修改建议
                  </Button>
                </div>
              )}

              <footer className="generation-bar">
                <div className="generation-meta">
                  {locked && busy ? (
                    <span className="status-line pending">
                      <LoadingOutlined /> {busy}
                    </span>
                  ) : (
                    <span className={`status-line ${saveState.tone}`}>
                      <span className="status-dot" />
                      {saveState.label}
                      <span className="meta-dot">·</span>第 {chapterIdx} 章 · {proseCount} 字
                    </span>
                  )}
                </div>
                <div className="generation-actions">
                  <Tooltip title="恢复上一份 AI 修改前的正文">
                    <Button
                      type="text"
                      icon={<UndoOutlined />}
                      aria-label="撤销 AI 修改"
                      disabled={locked || !undo.length}
                      onClick={() => {
                        editChapter(undo[undo.length - 1])
                        setUndo(values => values.slice(0, -1))
                        setSelection(null)
                      }}
                    >
                      撤销
                    </Button>
                  </Tooltip>
                  <Button
                    disabled={locked || !chapter.content.trim() || !chapter.raw_script.trim()}
                    onClick={() => generate('continue')}
                  >
                    继续写
                  </Button>
                  <Button
                    type="primary"
                    icon={<SendOutlined />}
                    disabled={locked || !chapter.raw_script.trim()}
                    onClick={() => generate('write')}
                  >
                    台本生成正文
                  </Button>
                </div>
              </footer>
            </>
          )}
        </main>

        <aside className={`inspector-panel ${mobilePanel === 'settings' ? 'mobile-open' : ''}`}>
          <Button
            className="mobile-only panel-close"
            type="text"
            icon={<CloseOutlined />}
            aria-label="关闭写作设置"
            onClick={() => setMobilePanel(null)}
          />
          {settings && (
            <Tabs
              activeKey={inspectorTab}
              onChange={setInspectorTab}
              items={[
                {
                  key: 'memory',
                  label: '记忆',
                  children: (
                    <MemoryPanel
                      settings={settings}
                      locked={locked}
                      navigationDisabled={navigationDisabled}
                      chapterDirty={chapterDirty}
                      hasContent={Boolean(chapter.content.trim())}
                      onChange={memory => editSettings({ memory })}
                      onExpand={() => setExpanded('memory')}
                      onHistory={showMemoryHistory}
                      onRestoreBeforeChapter={() => previewMemoryRestore()}
                      onSuggest={() => suggestMemory()}
                    />
                  ),
                },
                {
                  key: 'lore',
                  label: `设定${settings.lorebook.length ? ` ${settings.lorebook.length}` : ''}`,
                  children: (
                    <LorePanel
                      settings={settings}
                      models={models}
                      locked={locked}
                      portraits={portraits}
                      pendingPortraits={pendingPortraits}
                      onGeneratePortrait={entry => void generatePortrait(entry)}
                      onEditSettings={editSettings}
                      onOpenEntry={setLoreEdit}
                      onNewEntry={() =>
                        setLoreEdit({
                          id: crypto.randomUUID(),
                          title: '',
                          text: '',
                          keys: [],
                          enabled: true,
                          always_on: false,
                          category: '',
                        })
                      }
                      onImport={file => void importLore(file)}
                      onExport={exportLore}
                    />
                  ),
                },
                {
                  key: 'parameters',
                  label: (
                    <span>
                      参数
                      {noModel && <span className="tab-alert" aria-label="需要选择模型" />}
                    </span>
                  ),
                  children: (
                    <ParametersPanel
                      settings={settings}
                      models={models}
                      writingTemplate={writingTemplate}
                      locked={locked}
                      onEditSettings={editSettings}
                      onManageModels={() => openTool(() => onOpenTool('llm-configs'))}
                      onOpenStyle={() => openTool(() => onOpenTool('style'))}
                    />
                  ),
                },
              ]}
            />
          )}
        </aside>
      </div>

      <RepairModal
        repair={repair}
        locked={locked}
        current={repair?.source === JSON.stringify(requestBody())}
        onAccept={acceptRepair}
        onClose={() => setRepair(null)}
        onShowContext={showContext}
      />
      <RevisionModal
        revision={revision}
        warnings={revisionIssues}
        acknowledged={revisionAcknowledged}
        locked={locked}
        onAcknowledge={setRevisionAcknowledged}
        onChange={replacement => {
          setRevisionAcknowledged(false)
          setRevision(current => current && { ...current, replacement })
        }}
        onAccept={acceptRevision}
        onCancel={() => setRevision(null)}
      />
      <MemoryDraftModal
        draft={memoryDraft}
        locked={locked}
        onChange={proposed => setMemoryDraft(current => current && { ...current, proposed })}
        onConfirm={confirmMemoryDraft}
        onCancel={() => setMemoryDraft(null)}
      />
      <MemoryHistoryDrawer
        open={memoryHistoryOpen}
        versions={memoryVersions}
        version={memoryVersion}
        locked={locked}
        onSelect={id =>
          run('正在读取历史版本', async () => setMemoryVersion(await deskApi<MemoryVersion>(`/memory/history/${id}`)))
        }
        onPreviewRestore={id => previewMemoryRestore(id)}
        onClose={() => setMemoryHistoryOpen(false)}
      />
      <MemoryRestoreModal
        restore={memoryRestore}
        locked={locked}
        onConfirm={restoreMemory}
        onCancel={() => setMemoryRestore(null)}
      />
      <HistoryDrawer
        open={historyOpen}
        chapterIdx={chapterIdx}
        items={history}
        artifact={artifact}
        locked={locked}
        canRestoreMemory={!chapterDirty && Boolean(chapter.content.trim())}
        onOpenItem={id =>
          run('正在打开生成记录', async () =>
            setArtifact(await deskApi<Artifact>(`/chapter/${chapterIdx}/history/${id}`)),
          )
        }
        onRestore={restoreArtifact}
        onShowContext={showContext}
        onClose={() => setHistoryOpen(false)}
      />
      <ContextDrawer
        view={contextView}
        locked={locked}
        onPreview={next => void preview(next)}
        onClose={() => setContextView(null)}
      />
      <LoreEditModal
        entry={loreEdit}
        exists={Boolean(loreEdit && settings?.lorebook.some(entry => entry.id === loreEdit.id))}
        locked={locked}
        polishing={busy === '正在整理润色设定'}
        polishOpen={Boolean(lorePolish)}
        modelName={
          models.find(item => item.id === (settings?.lore_model_id || settings?.model_id))?.name ||
          '请先选择设定生成模型'
        }
        onChange={setLoreEdit}
        onSave={saveLore}
        onCancel={() => {
          setLoreEdit(null)
          setLorePolish(null)
        }}
        onDelete={() => {
          if (!settings || !loreEdit) return
          editSettings({ lorebook: settings.lorebook.filter(entry => entry.id !== loreEdit.id) })
          setLoreEdit(null)
        }}
        onPolish={polishLore}
      />
      <LorePolishModal
        polish={lorePolish}
        locked={locked}
        onChange={text => setLorePolish(current => current && { ...current, text })}
        onAccept={acceptLorePolish}
        onCancel={() => setLorePolish(null)}
      />

      <Modal
        title={`重命名第 ${renaming?.idx || ''} 章`}
        open={Boolean(renaming)}
        onCancel={() => !locked && setRenaming(null)}
        onOk={renameChapter}
        okText="保存标题"
        cancelText="取消"
        confirmLoading={locked}
        maskClosable={!locked}
        closable={!locked}
        okButtonProps={{ disabled: locked || !renaming?.title.trim() }}
        cancelButtonProps={{ disabled: locked }}
      >
        <Input
          aria-label="新的章节标题"
          maxLength={500}
          autoFocus
          value={renaming?.title || ''}
          disabled={locked}
          onChange={event => setRenaming(current => (current ? { ...current, title: event.target.value } : current))}
          onPressEnter={renameChapter}
        />
      </Modal>
      <Modal title="恢复上次未保存的编辑" open={Boolean(recovery)} closable={false} maskClosable={false} footer={null}>
        {recovery && (
          <>
            <p className="modal-description">
              第 {recovery.chapter_idx} 章 · 备份于 {new Date(recovery.saved_at).toLocaleString()}
              。服务器上的版本保持原样，请选择恢复编辑或使用已保存版本。
            </p>
            <div className="recovery-actions">
              <Button disabled={locked} onClick={() => setRecovery(null)}>
                使用已保存版本
              </Button>
              <Button
                type="primary"
                disabled={locked}
                onClick={() => {
                  setChapter(recovery.chapter)
                  setBaseChapter(recovery.base_chapter)
                  setSettings(recovery.settings)
                  setBaseSettings(recovery.base_settings)
                  setRecovery(null)
                }}
              >
                恢复未保存草稿
              </Button>
            </div>
          </>
        )}
      </Modal>
      <Modal
        title={expanded === 'memory' ? 'Memory · 全书记忆' : '作者批注 · 本章'}
        open={Boolean(expanded)}
        footer={<Button onClick={() => setExpanded(null)}>完成编辑</Button>}
        onCancel={() => setExpanded(null)}
        width={800}
      >
        <Input.TextArea
          aria-label={expanded === 'memory' ? '展开编辑 Memory' : '展开编辑作者批注'}
          autoSize={{ minRows: 16, maxRows: 28 }}
          disabled={locked}
          maxLength={expanded === 'memory' ? 100000 : 20000}
          value={expanded === 'memory' ? settings?.memory : chapter.author_note}
          onChange={event =>
            expanded === 'memory'
              ? editSettings({ memory: event.target.value })
              : editChapter({ author_note: event.target.value })
          }
        />
        <p className="panel-footnote">
          {expanded === 'memory'
            ? 'Memory 属于作品设定，点击顶部「保存设定」后保存。'
            : '作者批注随本章独立保存，停止编辑 3 秒后自动保存。'}
        </p>
      </Modal>
      <Modal
        title="导入设定"
        open={Boolean(importedLore)}
        onCancel={() => setImportedLore(null)}
        footer={
          <>
            <Button onClick={() => setImportedLore(null)}>取消</Button>
            <Button danger onClick={() => finishImport(true)}>
              替换现有设定
            </Button>
            <Button type="primary" onClick={() => finishImport(false)}>
              合并到现有设定
            </Button>
          </>
        }
      >
        <p className="modal-description">
          读取到 {importedLore?.length ?? 0}{' '}
          个条目。合并时保留现有条目；替换将移除编辑区内的现有设定。点击保存设定前不会改动已保存内容。
        </p>
      </Modal>
    </ConfigProvider>
  )
}
