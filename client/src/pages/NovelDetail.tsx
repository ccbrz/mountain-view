import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Tabs, Card, Form, Input, InputNumber, Select, Button,
  Modal, message, Spin, Space, Typography, Tag,
  Table, Popconfirm, Divider, Badge, Slider, Drawer, Collapse,
  Upload, Alert,
} from 'antd'
import {
  ArrowLeftOutlined, SettingOutlined, BookOutlined, OrderedListOutlined,
  FileTextOutlined, CompressOutlined, ThunderboltOutlined,
  PlayCircleOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  ApiOutlined, BugOutlined, ClearOutlined, ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import ReviewPanel from '../components/ReviewPanel'
import MemoryReview from '../components/MemoryReview'
import OutlineReview from '../components/OutlineReview'
import ChatTest from '../components/ChatTest'

const { TextArea } = Input

/** 角色档案存的是一份文本，每个人物以「## 姓名」一行开头；前端按这一行拆成卡片，保存时再拼回去 */
type CharacterEntry = { name: string; body: string }
function splitCharacters(text: string): CharacterEntry[] {
  const list: CharacterEntry[] = []
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/)
    if (m) list.push({ name: m[1], body: '' })
    else if (list.length) list[list.length - 1].body += line + '\n'
  }
  return list.map((c) => ({ ...c, body: c.body.trim() }))
}
const joinCharacters = (list: CharacterEntry[]) => list.map((c) => `## ${c.name}\n${c.body}`).join('\n\n')
const CHARACTER_TEMPLATE = `- 身份：
- 外貌：
- 性格特征：
- 说话方式：
- 背景故事：
- 核心欲望：
- 与其他角色的关系（故事开始时）：`
const { Text } = Typography

interface LLMConfig {
  id: number
  name: string
  interface_format: string
  base_url: string
  model_name: string
  has_key: boolean
  temperature: number
  max_tokens: number
  timeout: number
}

interface Chapter {
  id: number
  chapter_number: number
  title: string
  outline?: string
  outline_revision?: number
  content?: string
  status: string
  index_status: string
  word_count: number
  updated_at: string
}

interface LLMCallLog {
  id: string
  novel_id: number
  task: string
  model_name: string
  system_prompt: string
  user_prompt: string
  response: string
  timestamp: number
  duration_ms: number
  status: 'pending' | 'success' | 'error'
  error?: string
}

const TASK_LABELS: Record<string, { label: string; desc: string }> = {
  architecture: { label: '架构模型', desc: '核心种子 / 世界观 / 角色初稿' },
  chapter: { label: '起草模型', desc: '逐章正文生成（调用最频繁）' },
  finalize: { label: '记忆整理模型', desc: '整理候选记忆，由作者核对后定稿；也可手工填写' },
  consistency: { label: '审校模型', desc: '自动核验连续性与知情边界；审稿时检查台本和文笔' },
}

const INTERFACE_FORMATS = ['OpenAI', 'DeepSeek', 'Ollama', 'Gemini', 'Azure OpenAI', 'ML Studio']

export default function NovelDetail() {
  const bodySave = useRef<Promise<void>>(Promise.resolve())
  const outlineSave = useRef<Promise<void>>(Promise.resolve())
  const outlineRevisions = useRef<Record<number,number>>({})
  const [outlineError,setOutlineError] = useState('')
  const [outlineReview,setOutlineReview] = useState<{num:number;tab:'review'|'versions'}|null>(null)
  const bodyEditSequence = useRef(0)
  const [indexing, setIndexing] = useState<number | null>(null)
  const [memoryChapter, setMemoryChapter] = useState<number | null>(null)

  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [novel, setNovel] = useState<any>(null)
  const [docs, setDocs] = useState<Record<string, string>>({})
  const [progressSnaps, setProgressSnaps] = useState<{ chapter_number: number }[]>([])
  const [progressContent, setProgressContent] = useState('')
  const [progressLoading, setProgressLoading] = useState(false)
  const [progressError, setProgressError] = useState('')
  const [activeTab, setActiveTab] = useState('settings')
  const [detailRefresh, setDetailRefresh] = useState(0)
  const [chapterError, setChapterError] = useState('')
  const [progressView, setProgressView] = useState<number>(0) // 0 = 最新
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [allConfigs, setAllConfigs] = useState<LLMConfig[]>([])
  const [taskConfigs, setTaskConfigs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState<string | null>(null)

  // doc editor
  const [docModalOpen, setDocModalOpen] = useState(false)
  const [docModalType, setDocModalType] = useState('')
  const [docModalContent, setDocModalContent] = useState('')
  // 角色弹窗：index 为 null 表示新增
  const [charEdit, setCharEdit] = useState<{ index: number | null; name: string; body: string } | null>(null)
  const [polishing, setPolishing] = useState(false)
  const [preEditBody, setPreEditBody] = useState<string | null>(null) // 润色前的原稿，用于撤销

  // chapter viewer
  const [chapterViewOpen, setChapterViewOpen] = useState(false)
  const [viewingChapter, setViewingChapter] = useState<Chapter | null>(null)
  const [chapterContent, setChapterContent] = useState('')

  // LLM config editor
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const [editingConfig, setEditingConfig] = useState<LLMConfig | null>(null)
  const [configForm] = Form.useForm()

  // architecture user input
  const [architectureInput, setArchitectureInput] = useState('')
  const [savingInput, setSavingInput] = useState(false)

  // style
  const [styleGuide, setStyleGuide] = useState('')
  const [styleGuideInput, setStyleGuideInput] = useState('')
  const [extractingStyle, setExtractingStyle] = useState(false)

  // 审稿面板自行管理审稿与修订状态，这里只留章节刷新回调

  // settings form
  const [settingsForm] = Form.useForm()

  // embedding config
  const [embeddingConfig, setEmbeddingConfig] = useState('')
  const [testingEmbedding, setTestingEmbedding] = useState(false)

  // LLM log viewer
  const [logDrawerOpen, setLogDrawerOpen] = useState(false)
  const [debugTab, setDebugTab] = useState('chat')
  const [llmLogs, setLlmLogs] = useState<LLMCallLog[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const logPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // chapter editor: 顶部章节 tab + 台本/正文两栏
  const [selectedChapterId, setSelectedChapterId] = useState<number | null>(null)
  const [outlineWidth, setOutlineWidth] = useState(40) // 台本栏宽度 %，正文占剩余
  const [dragging, setDragging] = useState(false)

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return
    const rect = e.currentTarget.getBoundingClientRect()
    setOutlineWidth(Math.max(20, Math.min(70, ((e.clientX - rect.left) / rect.width) * 100)))
  }

  const handleMouseUp = () => {
    setDragging(false)
  }

  // 没有选中（或选中的被删了）时默认选第一章
  useEffect(() => {
    if (chapters.length > 0 && !chapters.some((c) => c.id === selectedChapterId)) {
      setSelectedChapterId(chapters[0].id)
    }
  }, [chapters, selectedChapterId])

  useEffect(() => {
    if (!id || activeTab !== 'chapters' || !selectedChapterId) return
    const selected = chapters.find(c => c.id === selectedChapterId)
    if (!selected) return
    let cancelled = false
    setChapterError('')
    const load = async () => {
      await Promise.all([bodySave.current,outlineSave.current])
      const sequence = bodyEditSequence.current
      const res = await api.get(`/novels/${id}/chapters/${selected.chapter_number}`)
      if (!cancelled && sequence === bodyEditSequence.current) {
        outlineRevisions.current[selected.chapter_number]=res.data.outline_revision
        setChapters(prev => prev.map(c => c.id === selected.id ? { ...c, ...res.data } : c))
      }
    }
    void load().catch((err: any) => {
      if (!cancelled) setChapterError(err.response?.data?.message || '章节加载失败，请重试')
    })
    return () => { cancelled = true }
  }, [id, activeTab, selectedChapterId, detailRefresh])

  useEffect(() => {
    if (!id) return
    Promise.all([
      api.get(`/novels/${id}`),
      api.get(`/novels/${id}/docs`),
      api.get(`/novels/${id}/chapters`),
      api.get('/llm-configs'),
    ]).then(([n, d, c, l]) => {
      setNovel(n.data)
      setDocs(d.data)
      setChapters(c.data)
      setAllConfigs(l.data)
      if (d.data.architecture) {
        setArchitectureInput(d.data.architecture)
      }

      let saved: Record<string, string> = {}
      if (n.data.llm_config && typeof n.data.llm_config === 'string' && n.data.llm_config.startsWith('{')) {
        try { saved = JSON.parse(n.data.llm_config) } catch {}
      }
      if (Object.keys(saved).length === 0 && l.data.length > 0) {
        const firstName = l.data[0].name
        saved = { architecture: firstName, blueprint: firstName, chapter: firstName, finalize: firstName, consistency: firstName }
        api.put(`/novels/${id}`, { llm_config: JSON.stringify(saved) }).catch(() => {})
      }
      setTaskConfigs(saved)
      setEmbeddingConfig(n.data.embedding_config || '')
      setStyleRefText(n.data.style_reference || '')
      setStyleGuide(n.data.style_guide || '')
      settingsForm.setFieldsValue(n.data)
    }).catch(() => message.error('加载小说失败'))
      .finally(() => setLoading(false))
  }, [id])

  const fetchConfigs = async () => {
    const res = await api.get('/llm-configs')
    setAllConfigs(res.data)
  }

  const fetchLogs = async () => {
    setLogsLoading(true)
    try {
      const res = await api.get(`/novels/${id}/llm-logs?limit=100`)
      setLlmLogs(res.data)
    } catch {
      // ignore
    } finally {
      setLogsLoading(false)
    }
  }

  const clearLogs = async () => {
    try {
      await api.delete(`/novels/${id}/llm-logs`)
      setLlmLogs([])
      message.success('日志已清空')
    } catch {
      message.error('清空日志失败')
    }
  }

  const openLogDrawer = () => {
    setLogDrawerOpen(true)
  }

  const closeLogDrawer = () => {
    setLogDrawerOpen(false)
    if (logPollRef.current) {
      clearInterval(logPollRef.current)
      logPollRef.current = null
    }
  }

  useEffect(() => {
    if(logDrawerOpen&&debugTab==='logs'){
      void fetchLogs()
      logPollRef.current=setInterval(fetchLogs,3000)
    }
    return () => {
      if (logPollRef.current) clearInterval(logPollRef.current)
    }
  }, [logDrawerOpen,debugTab,id])

  const saveSettings = async () => {
    const vals = await settingsForm.validateFields()
    await api.put(`/novels/${id}`, { ...vals, llm_config: JSON.stringify(taskConfigs) })
    message.success('已保存')
    const n = await api.get(`/novels/${id}`)
    setNovel(n.data)
    await refreshChapters()
  }

  const saveArchitectureInput = async () => {
    setSavingInput(true)
    try {
      await api.put(`/novels/${id}/docs/architecture`, { content: architectureInput })
      await refreshChapters()
      message.success('架构已保存')
    } catch {
      message.error('保存失败')
    } finally {
      setSavingInput(false)
    }
  }

  const extractStyleGuide = async (text: string) => {
    if (!text || text.trim().length < 100) {
      message.error('范文内容太短，请至少提供100字以上的文本')
      return false
    }
    if (!taskConfigs.architecture) {
      message.error('请先在 LLM 配置中选择架构模型')
      return false
    }
    setExtractingStyle(true)
    try {
      const res = await api.post(`/novels/${id}/style/guide`, {
        content: text,
        llm_config: taskConfigs.architecture
      })
      setStyleGuide(res.data.style_guide)
      message.success('文风指南提取完成')
      return true
    } catch (err: any) {
      message.error('文风提取失败: ' + (err.response?.data?.message || err.message))
      return false
    } finally {
      setExtractingStyle(false)
    }
  }

  const saveStyleReference = async (text: string) => {
    if (!text || text.trim().length === 0) {
      message.error('内容不能为空')
      return
    }
    if (text.length > 1000) {
      message.error('范文片段不能超过1000字')
      return
    }
    try {
      await api.put(`/novels/${id}/style/reference`, { content: text })
      message.success('范文片段已保存')
    } catch (err: any) {
      message.error('保存失败: ' + (err.response?.data?.message || err.message))
    }
  }

  const [styleRefText, setStyleRefText] = useState('')
  const [savingStyleRef, setSavingStyleRef] = useState(false)

  const handleTaskConfigChange = async (task: string, configName: string) => {
    const next = { ...taskConfigs, [task]: configName }
    setTaskConfigs(next)
    if (id) {
      await api.put(`/novels/${id}`, { llm_config: JSON.stringify(next) })
    }
  }

  const handleEmbeddingConfigChange = async (configName?: string) => {
    setTestingEmbedding(true)
    try {
      await api.put(`/novels/${id}`, { embedding_config: configName || '' })
      setEmbeddingConfig(configName || '')
      message.success(configName ? '向量接口测试通过，配置已保存' : '已关闭向量检索，仍可检索历史原文')
    } catch (err: any) {
      message.error(err.response?.data?.message || err.message)
    } finally { setTestingEmbedding(false) }
  }

  const taskForAction = (action: string): string => {
    if (action === 'architecture') return 'architecture'
    if (action === 'finalize') return 'finalize'
    return 'chapter'
  }

  const callGenerate = async (action: string, extra?: string, userInput?: string) => {
    const task = taskForAction(action)
    const cfgName = taskConfigs[task]
    if (!cfgName) return message.error(`请先在设置中选择「${TASK_LABELS[task]?.label || task}」对应的 LLM 配置`)
    const cfg = allConfigs.find((c) => c.name === cfgName)
    if (!cfg?.has_key) return message.error(`"${cfgName}" 未配置 API Key`)

    setGenerating(extra ? `${action}:${extra}` : action)
    try {
      await Promise.all([bodySave.current,outlineSave.current])
      await api.put(`/novels/${id}`, { llm_config: JSON.stringify(taskConfigs) })

      const url = extra
        ? `/novels/${id}/generate/${action}/${extra}`
        : `/novels/${id}/generate/${action}`
      const res = await api.post(url, { llm_config: cfgName, user_input: userInput })
      if (res.data.warning) message.warning(res.data.warning, 8)
      else message.success(res.data.message)

      const currentDocs = await refreshChapters()
      if (action === 'architecture' && currentDocs?.architecture) {
        setArchitectureInput(currentDocs.architecture)
      }
      const n = await api.get(`/novels/${id}`)
      setNovel(n.data)
    } catch (err: any) {
      message.error(err.response?.data?.message || '生成失败')
    } finally {
      setGenerating(null)
    }
  }

  // 只有打开进度页时才请求目录和当前选中的一份进度，切换时忽略迟到的响应。
  useEffect(() => {
    if (!id || activeTab !== 'progress') return
    let cancelled = false
    setProgressLoading(true)
    setProgressContent('')
    setProgressError('')
    const load = async () => {
      const list = await api.get(`/novels/${id}/progress-snapshots`)
      if (cancelled) return
      setProgressSnaps(list.data)
      if (progressView && !list.data.some((p: { chapter_number: number }) => p.chapter_number === progressView)) {
        setProgressView(0)
        return
      }
      const res = await api.get(`/novels/${id}/progress-snapshots/${progressView || 'latest'}`)
      if (!cancelled) setProgressContent(res.data.content)
    }
    void load().catch((err: any) => {
      if (!cancelled) setProgressError(err.response?.data?.message || '进度加载失败')
    }).finally(() => { if (!cancelled) setProgressLoading(false) })
    return () => { cancelled = true }
  }, [id, activeTab, progressView, docs])

  const openDocEditor = (type: string) => {
    setDocModalType(type)
    const labels: Record<string, string> = {
      architecture: '小说架构',
    }
    setDocModalContent(docs[type] || `（${labels[type] || type} 尚未生成）`)
    setDocModalOpen(true)
  }

  const saveDocContent = async () => {
    await api.put(`/novels/${id}/docs/${docModalType}`, { content: docModalContent })
    message.success('已保存')
    setDocModalOpen(false)
    await refreshChapters()
  }

  const characterList = splitCharacters(docs.characters || '')

  const saveCharacters = async (list: CharacterEntry[]) => {
    const content = joinCharacters(list)
    await api.put(`/novels/${id}/docs/characters`, { content })
    await refreshChapters()
    message.success('已保存')
  }

  const submitCharEdit = async () => {
    if (!charEdit) return
    const name = charEdit.name.trim()
    if (!name) return message.warning('请填写姓名')
    const list = [...characterList]
    const entry = { name, body: charEdit.body.trim() }
    if (charEdit.index === null) list.push(entry)
    else list[charEdit.index] = entry
    await saveCharacters(list)
    closeCharEdit()
  }

  const polishCharacter = async () => {
    if (!charEdit?.body.trim()) return message.warning('先写点内容再润色')
    setPolishing(true)
    try {
      const res = await api.post(`/novels/${id}/polish/character`, { name: charEdit.name, body: charEdit.body })
      setPreEditBody(charEdit.body)
      setCharEdit((p) => p && { ...p, body: res.data.body })
    } catch (err: any) {
      message.error(err.response?.data?.message || '润色失败')
    } finally {
      setPolishing(false)
    }
  }

  const closeCharEdit = () => {
    setCharEdit(null)
    setPreEditBody(null)
  }

  const saveOutline = (ch: Chapter, outline: string) => {
    ++bodyEditSequence.current
    setChapters(prev=>prev.map(c=>c.id===ch.id?{...c,outline}:c))
    // 顺序提交并携带版本；失败后暂停队列，保留窗口内输入供作者复制或合并。
    const pending=outlineSave.current.then(async()=>{
      const revision=outlineRevisions.current[ch.chapter_number] ?? ch.outline_revision
      const {data}=await api.put(`/novels/${id}/chapters/${ch.chapter_number}`,{outline,outline_revision:revision})
      outlineRevisions.current[ch.chapter_number]=data.outline_revision
    })
    outlineSave.current=pending
    void pending.catch((err:any)=>setOutlineError(err.response?.data?.message||'台本保存失败，本地输入已保留'))
  }

  const viewChapter = async (ch: Chapter) => {
    setViewingChapter(ch)
    try {
      const res = await api.get(`/novels/${id}/chapters/${ch.chapter_number}`)
      setChapterContent(res.data.content || '')
    } catch {
      setChapterContent('')
    }
    setChapterViewOpen(true)
  }

  const saveChapterContent = async () => {
    if (!viewingChapter) return
    await Promise.all([bodySave.current,outlineSave.current])
    await api.put(`/novels/${id}/chapters/${viewingChapter.chapter_number}`, { content: chapterContent })
    message.success('章节已保存')
    setChapterViewOpen(false)
    await refreshChapters()
  }

  const addChapter = async () => {
    // 删除中间章节后先补缺口，避免后续章节永远无法满足前置条件。
    let newChapterNum = 1
    const existing = new Set(chapters.map(c => c.chapter_number))
    while (existing.has(newChapterNum)) newChapterNum++
    try {
      const res = await api.post(`/novels/${id}/chapters`, {
        chapter_number: newChapterNum,
        title: `第${newChapterNum}章`,
        outline: '',
        content: ''
      })
      message.success('章节已创建')
      await refreshChapters()
      setSelectedChapterId(Number(res.data.id))
    } catch (err: any) {
      message.error('创建章节失败: ' + (err.response?.data?.message || err.message))
    }
  }

  const deleteChapter = async (chapterId: number) => {
    try {
      await Promise.all([bodySave.current,outlineSave.current])
      await api.delete(`/novels/${id}/chapters/${chapterId}`)
      message.success('章节已删除')
      await refreshChapters()
      // 如果删除的是当前选中的章节，清空选中状态
      if (selectedChapterId === chapterId) {
        setSelectedChapterId(null)
      }
    } catch (err: any) {
      message.error('删除章节失败: ' + (err.response?.data?.message || err.message))
    }
  }

  const exportChapters = async () => {
    try {
      await Promise.all([bodySave.current,outlineSave.current])
      // 全文只在用户明确导出时一次获取，避免数百个并发章节请求。
      const { data: chapterContents } = await api.get<Chapter[]>(`/novels/${id}/export`)

      // 拼接成完整的文本
      let fullText = `${novel?.title || '小说'}\n\n`
      fullText += `作者：${user?.username || '未知'}\n`
      fullText += `导出时间：${new Date().toLocaleString('zh-CN')}\n\n`
      fullText += `${'='.repeat(50)}\n\n`

      chapterContents.forEach((ch) => {
        fullText += `第 ${ch.chapter_number} 章 ${ch.title || ''}\n\n`
        fullText += `${ch.content || '（暂无内容）'}\n\n`
        fullText += `${'-'.repeat(30)}\n\n`
      })

      // 创建 Blob 并触发下载
      const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${novel?.title || '小说'}.txt`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      message.success('导出成功')
    } catch (err: any) {
      message.error('导出失败: ' + (err.response?.data?.message || err.message))
    }
  }

  const refreshChapters = async () => {
    await Promise.all([bodySave.current,outlineSave.current])
    const sequence = bodyEditSequence.current
    const [c, d] = await Promise.all([api.get(`/novels/${id}/chapters`), api.get(`/novels/${id}/docs`)])
    if (sequence !== bodyEditSequence.current) return // 刷新不能覆盖请求期间的新输入
    // 目录不带正文，仅保留当前正在编辑的章节；随后按需刷新这一章。
    setChapters(prev => c.data.map((row: Chapter) => {
      const current = prev.find(ch => ch.id === row.id && ch.id === selectedChapterId)
      return current ? { ...row, content: current.content, outline: current.outline } : row
    }))
    setDetailRefresh(value => value + 1)
    setDocs(d.data)
    return d.data
  }

  const saveBody = (ch: Chapter, content: string) => {
    const sequence = ++bodyEditSequence.current
    setChapters(prev => prev.map(c => c.chapter_number < ch.chapter_number ? c : {
      ...c,
      ...(c.id === ch.id ? { content, word_count: content.replace(/\s/g, '').length } : {}),
      status: c.id === ch.id || c.word_count === 0 ? 'draft' : 'needs_review', index_status: 'pending',
    }))
    // 连续输入顺序保存，确保后发的正文不会被先发请求覆盖。
    const pending = bodySave.current.catch(() => {}).then(async () => {
      await api.put(`/novels/${id}/chapters/${ch.chapter_number}`, { content })
    })
    bodySave.current = pending
    void pending.then(async () => {
      if (sequence === bodyEditSequence.current) await refreshChapters()
    }).catch((err: any) => message.error('正文保存失败：' + (err.response?.data?.message || err.message)))
  }

  const retryIndex = async (num: number) => {
    setIndexing(num)
    try {
      await Promise.all([bodySave.current,outlineSave.current])
      const res = await api.post(`/novels/${id}/chapters/${num}/reindex`)
      message.success(res.data.message)
      await refreshChapters()
    } catch (err: any) {
      message.error(err.response?.data?.message || '索引更新失败')
    } finally {
      setIndexing(null)
    }
  }

  // LLM Config CRUD
  const openCreateConfig = () => {
    setEditingConfig(null)
    configForm.resetFields()
    configForm.setFieldsValue({
      interface_format: 'OpenAI',
      temperature: 0.7,
      max_tokens: 4096,
      timeout: 600,
    })
    setConfigModalOpen(true)
  }

  const openEditConfig = (config: LLMConfig) => {
    setEditingConfig(config)
    configForm.resetFields() // 接口不再返回 api_key，不重置会带上一次输入的 Key
    configForm.setFieldsValue(config)
    setConfigModalOpen(true)
  }

  const saveConfig = async () => {
    const values = await configForm.validateFields()
    if (editingConfig) {
      await api.put(`/llm-configs/${editingConfig.id}`, values)
      message.success('配置已更新')
    } else {
      await api.post('/llm-configs', values)
      message.success('配置已创建')
    }
    setConfigModalOpen(false)
    fetchConfigs()
  }

  const deleteConfig = async (configId: number) => {
    await api.delete(`/llm-configs/${configId}`)
    message.success('配置已删除')
    fetchConfigs()
  }

  const testConfig = async (configId: number, kind = 'chat') => {
    try {
      const res = await api.post(`/llm-configs/${configId}/test`, { kind })
      if (res.data.success) {
        message.success(res.data.message)
      } else {
        message.error(res.data.message)
      }
    } catch (err: any) {
      message.error('测试失败: ' + (err.response?.data?.message || err.message))
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  const docLabels: Record<string, string> = {
    architecture: '小说架构（核心种子 / 世界观）',
    progress: '故事进度',
  }

  const configColumns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '模型', dataIndex: 'model_name', key: 'model_name' },
    { title: 'Base URL', dataIndex: 'base_url', key: 'base_url', ellipsis: true },
    {
      title: 'Key', dataIndex: 'has_key', key: 'has_key', width: 60,
      render: (hasKey: boolean) => hasKey ? <Tag color="green">✓</Tag> : <Tag color="red">✗</Tag>,
    },
    {
      title: '操作', key: 'action', width: 320,
      render: (_: unknown, record: LLMConfig) => (
        <Space>
          <Button type="link" size="small" icon={<ApiOutlined />} onClick={() => testConfig(record.id)}>测试对话</Button>
          <Button type="link" size="small" onClick={() => testConfig(record.id, 'embedding')}>测试向量</Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEditConfig(record)}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => deleteConfig(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const tabItems = [
    {
      key: 'settings',
      label: <span><SettingOutlined /> 设置</span>,
      children: (
        <Card title="小说参数">
          <Form form={settingsForm} layout="vertical" style={{ maxWidth: 600 }}>
            <Form.Item name="title" label="小说标题" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="genre" label="类型">
              <Input placeholder="玄幻 / 科幻 / 悬疑 / 言情..." />
            </Form.Item>
            <Form.Item name="num_chapters" label="章节数">
              <InputNumber min={1} max={200} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="word_number" label="每章目标字数">
              <InputNumber min={100} max={50000} step={500} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="guidance" label="写作指引">
              <TextArea rows={3} placeholder="对故事风格、内容走向的额外要求..." />
            </Form.Item>

            <Button type="primary" onClick={saveSettings}>保存设置</Button>
          </Form>
        </Card>
      ),
    },
    {
      key: 'llm-configs',
      label: <span><ApiOutlined /> LLM 配置</span>,
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <Card
            title="LLM 模型配置"
            extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreateConfig}>添加配置</Button>}
          >
            <Table
              dataSource={allConfigs}
              columns={configColumns}
              rowKey="id"
              pagination={false}
            />
          </Card>

          <Card title="任务模型分配">
            {Object.entries(TASK_LABELS).map(([key, { label, desc }]) => (
              <Form.Item key={key} label={label} help={desc} style={{ marginBottom: 16 }}>
                <Select
                  value={taskConfigs[key]}
                  onChange={(v) => handleTaskConfigChange(key, v)}
                  placeholder="选择模型"
                  style={{ maxWidth: 400 }}
                >
                  {allConfigs.map((c) => (
                    <Select.Option key={c.name} value={c.name}>
                      {c.name} ({c.model_name}) {c.has_key ? '' : '⚠️ 未配置 Key'}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            ))}
          </Card>

          <Card title="Embedding 配置">
            <Form.Item label="Embedding 模型" help="选择时会测试向量接口（最长30秒）。需使用 Embedding 模型；服务故障时仍检索历史原文。" style={{ marginBottom: 0 }}>
              <Select
                value={embeddingConfig || undefined}
                loading={testingEmbedding}
                disabled={testingEmbedding}
                onChange={handleEmbeddingConfigChange}
                placeholder="选择 Embedding 模型"
                style={{ maxWidth: 400 }}
                allowClear
              >
                {allConfigs.map((c) => (
                  <Select.Option key={c.name} value={c.name}>
                    {c.name} ({c.model_name}) {c.has_key ? '' : '⚠️ 未配置 Key'}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Card>
        </Space>
      ),
    },
    {
      key: 'architecture',
      label: <span><BookOutlined /> 架构</span>,
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <Card
            title="小说架构（核心种子 / 世界观）"
            extra={
              <Space>
                <Button
                  loading={savingInput}
                  onClick={saveArchitectureInput}
                >
                  保存
                </Button>
                <Button
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  loading={generating === 'architecture'}
                  onClick={() => callGenerate('architecture', undefined, architectureInput)}
                  disabled={!taskConfigs.architecture}
                >
                  生成架构
                </Button>
              </Space>
            }
          >
            <Spin spinning={generating === 'architecture'} tip="AI 正在整理架构...">
              <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
                请输入你的架构构想，点击"生成架构"让 AI 整理为最佳实践，确认后点击"保存"：
              </div>
              <TextArea
                value={architectureInput}
                onChange={(e) => setArchitectureInput(e.target.value)}
                rows={16}
                placeholder="例如：一个关于时间旅行的故事，主角是一个物理学家，他发现了一种可以回到过去的方法，但每次改变过去都会导致未来发生不可预测的变化..."
                style={{ fontFamily: 'inherit', fontSize: 14 }}
              />
            </Spin>
          </Card>
          <Card
            title="角色"
            extra={
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCharEdit({ index: null, name: '', body: CHARACTER_TEMPLATE })}>
                添加角色
              </Button>
            }
          >
            {characterList.length === 0 ? (
              <Typography.Text type="secondary">尚无角色。生成架构时会自动生成一版初稿，也可以手动添加。</Typography.Text>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }}>
                {characterList.map((c, i) => (
                  <Card
                    key={`${c.name}-${i}`}
                    size="small"
                    title={c.name}
                    extra={
                      <Space>
                        <Button size="small" icon={<EditOutlined />} onClick={() => setCharEdit({ index: i, name: c.name, body: c.body })}>编辑</Button>
                        <Popconfirm title={`删除角色「${c.name}」？`} onConfirm={() => saveCharacters(characterList.filter((_, j) => j !== i))}>
                          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                        </Popconfirm>
                      </Space>
                    }
                  >
                    <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.8, color: '#333', margin: 0 }}>
                      {c.body}
                    </pre>
                  </Card>
                ))}
              </Space>
            )}
          </Card>
        </Space>
      ),
    },
    {
      key: 'style',
      label: <span><FileTextOutlined /> 文风</span>,
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <Card
            title="上传范文 → 提取文风指南"
            extra={
              <Button
                loading={extractingStyle}
                onClick={() => extractStyleGuide(styleGuideInput)}
                disabled={extractingStyle}
              >
                {extractingStyle ? '提取中...' : '提取文风指南'}
              </Button>
            }
          >
            <Spin spinning={extractingStyle} tip="AI 正在分析文风特征...">
              <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
                上传一个或多个 .txt 文件，AI 会自动提取其写作风格特征：
              </div>
              <Upload
                accept=".txt"
                multiple
                beforeUpload={(file) => {
                  const reader = new FileReader()
                  reader.onload = (e) => {
                    const buffer = e.target?.result as ArrayBuffer
                    const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
                    const text = utf8Text.includes('\uFFFD')
                      ? new TextDecoder('gbk', { fatal: false }).decode(buffer)
                      : utf8Text
                    setStyleGuideInput((prev) => prev ? prev + '\n\n---\n\n' + text : text)
                  }
                  reader.readAsArrayBuffer(file)
                  return false
                }}
                showUploadList={false}
              >
                <Button icon={<UploadOutlined />}>选择 .txt 文件</Button>
              </Upload>
              <TextArea
                value={styleGuideInput}
                onChange={(e) => setStyleGuideInput(e.target.value)}
                rows={8}
                placeholder="拖入或选择 .txt 文件后内容会出现在这里，点击「提取文风指南」按钮由 AI 分析...&#10;&#10;你也可以直接粘贴范文内容"
                style={{ fontFamily: 'inherit', fontSize: 14, marginTop: 12 }}
              />
              {styleGuide && (
                <>
                  <Divider style={{ margin: '16px 0' }}>
                    <span style={{ color: '#52c41a' }}>✓ 已提取的文风指南（注入 System Prompt）</span>
                  </Divider>
                  <pre style={{
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    lineHeight: 1.8,
                    color: '#333',
                    background: '#f6ffed',
                    padding: 16,
                    borderRadius: 6,
                    border: '1px solid #b7eb8f',
                    maxHeight: 300,
                    overflow: 'auto',
                  }}>
                    {styleGuide}
                  </pre>
                </>
              )}
            </Spin>
          </Card>

          <Card
            title="范文片段（Few-shot）"
            extra={
              <Button
                loading={savingStyleRef}
                onClick={async () => {
                  setSavingStyleRef(true)
                  await saveStyleReference(styleRefText)
                  setSavingStyleRef(false)
                }}
                disabled={!styleRefText || styleRefText.length > 1000}
              >
                保存
              </Button>
            }
          >
            <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
              粘贴一段范文原文（1000 字以内），生成章节时会作为文笔示范放在小说设定之前，只学写法、不用其中的人物和情节：
            </div>
            <TextArea
              value={styleRefText}
              onChange={(e) => setStyleRefText(e.target.value)}
              rows={6}
              maxLength={1000}
              showCount
              placeholder="在此粘贴范文原文片段（不超过 1000 字）..."
              style={{ fontFamily: 'serif', fontSize: 14 }}
            />
          </Card>
        </Space>
      ),
    },
    {
      key: 'progress',
      label: <span><CompressOutlined /> 进度</span>,
      children: (
        <Card
          title={docLabels.progress}
          extra={
            <Select
              style={{ width: 180 }}
              value={progressView}
              onChange={setProgressView}
              options={[
                { value: 0, label: '最新有效进度' },
                ...progressSnaps.map((p) => ({ value: p.chapter_number, label: `进入第 ${p.chapter_number} 章时` })),
              ]}
            />
          }
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            每章人工核对记忆并定稿后更新。需要修正时，在对应章节点击「核对 / 修正记忆」。起草和审稿第 N 章时使用「进入第 N 章时」的版本。
          </Typography.Paragraph>
          <Spin spinning={progressLoading}>
            {progressError ? <Alert type="error" message={progressError} /> : (
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.8, color: '#333', minHeight: 200 }}>
                {progressContent || (progressLoading ? '加载中…' : '（尚无进度，第一章定稿后生成）')}
              </pre>
            )}
          </Spin>
        </Card>
      ),
    },
    {
      key: 'chapters',
      label: <span><FileTextOutlined /> 章节</span>,
      children: (
        <div>
          {chapters.some(c=>c.status==='needs_review') && <Alert style={{marginBottom:12}} type="info" showIcon
            message="已有正文已保留，请按顺序核对记忆以恢复写作进度。"
            description="可以让 AI 整理，也可以直接手工确认事实和伏笔，不需要重新生成正文。"
            action={<Button onClick={()=>{
              const next = chapters.find(c=>c.status!=='finalized')
              if (next) { setSelectedChapterId(next.id); if(next.word_count>0) setMemoryChapter(next.chapter_number) }
            }}>前往首个待处理章节</Button>} />}
          {/* 顶部：章节 tab（横向可滚动，+ 新建，× 删除）+ 全文导出 */}
          <Tabs
            type="editable-card"
            size="small"
            activeKey={selectedChapterId != null ? String(selectedChapterId) : undefined}
            onChange={(key) => setSelectedChapterId(Number(key))}
            onEdit={(key, action) => {
              if (action === 'add') {
                addChapter()
                return
              }
              const ch = chapters.find((c) => c.id === Number(key))
              Modal.confirm({
                title: `确定删除第 ${ch?.chapter_number ?? ''} 章？`,
                okText: '删除',
                okType: 'danger',
                cancelText: '取消',
                onOk: () => deleteChapter(Number(key)),
              })
            }}
            tabBarExtraContent={{
              right: (
                <Button size="small" onClick={exportChapters} disabled={chapters.length === 0} style={{ marginLeft: 8 }}>
                  导出全文
                </Button>
              ),
            }}
            tabBarStyle={{ marginBottom: 12 }}
            items={chapters.map((ch) => ({
              key: String(ch.id),
              label: (
                <span title={ch.title || ''} style={{ display: 'inline-block', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                  {ch.word_count > 0 && <span title={ch.status === 'finalized' ? '已定稿' : ch.status === 'needs_review' ? '前文已变化，待审校' : '待定稿'} style={{ color: ch.status === 'finalized' ? '#52c41a' : '#faad14', marginRight: 4 }}>●</span>}
                  {ch.title && ch.title !== `第${ch.chapter_number}章` ? `${ch.chapter_number}. ${ch.title}` : `第${ch.chapter_number}章`}
                </span>
              ),
            }))}
          />
          {chapters.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: '#999' }}>
              暂无章节，点击上方 + 新建
            </div>
          )}

        <div
          className="responsive-editor-panel"
          style={{ display: 'flex', minHeight: '600px', position: 'relative', userSelect: dragging ? 'none' : 'auto' }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* 左：台本编辑区 */}
          <Card
            title="台本"
            style={{ width: `${outlineWidth}%`, flexShrink: 0 }}
            bodyStyle={{ padding: 16 }}
          >
            {selectedChapterId ? (
              (() => {
                const ch = chapters.find((c) => c.id === selectedChapterId)
                if (!ch) return <div>章节不存在</div>
                if (chapterError) return <Alert type="error" message={chapterError} action={<Button onClick={() => setDetailRefresh(v => v + 1)}>重试</Button>} />
                if (ch.content === undefined) return <Spin tip="加载章节中…"><div style={{ minHeight: 160 }} /></Spin>
                return (
                  <div>
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>章节标题</div>
                      <Input
                        value={ch.title || ''}
                        onChange={async (e) => {
                          const newTitle = e.target.value
                          setChapters((prev) => prev.map((c) => c.id === ch.id ? { ...c, title: newTitle } : c))
                          await api.put(`/novels/${id}/chapters/${ch.chapter_number}`, { title: newTitle })
                        }}
                        placeholder="章节标题"
                      />
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <Space style={{ marginBottom: 4 }}>
                        <span style={{ fontSize: 12, color: '#666' }}>台本（剧情梗概）</span>
                        <Button size="small" disabled={!!generating||!!outlineError} onClick={()=>setOutlineReview({num:ch.chapter_number,tab:'review'})}>AI 整理台本</Button>
                        <Button size="small" type="link" disabled={!!generating||!!outlineError} onClick={()=>setOutlineReview({num:ch.chapter_number,tab:'versions'})}>台本版本</Button>
                        <span style={{color:'#999',fontSize:12}}>先核对候选，确认后再采纳</span>
                      </Space>
                      <TextArea
                        value={ch.outline || ''}
                        onChange={e=>saveOutline(ch,e.target.value)}
                        placeholder="请输入本章台本（剧情梗概）..."
                        rows={15}
                        style={{ fontFamily: 'inherit', fontSize: 14 }}
                      />
                    </div>
                    <Button
                      type="primary"
                      block
                      loading={generating === `chapter:${ch.chapter_number}`}
                      onClick={() => callGenerate('chapter', String(ch.chapter_number))}
                      disabled={!ch.outline}
                    >
                      {ch.word_count > 0 ? '重新生成正文' : '生成正文'}
                    </Button>
                  </div>
                )
              })()
            ) : (
              <div style={{ padding: 24, textAlign: 'center', color: '#999' }}>
                请先在上方选择或新建章节
              </div>
            )}
          </Card>

          {/* 分隔条 */}
          <div
            onMouseDown={handleMouseDown}
            style={{
              width: 8,
              cursor: 'col-resize',
              background: dragging ? '#1890ff' : '#f0f0f0',
              transition: dragging ? 'none' : 'background 0.2s',
              flexShrink: 0,
            }}
          />

          {/* 右：正文编辑区 */}
          <Card
            title="正文"
            style={{ flex: 1, minWidth: 0 }}
            bodyStyle={{ padding: 16 }}
            extra={
              selectedChapterId && (() => {
                const ch = chapters.find((c) => c.id === selectedChapterId)
                if (!ch?.content?.trim()) return null
                return (
                  <Space>
                    {!!embeddingConfig && ch.status === 'finalized' && ch.index_status !== 'ready' && (
                      <>
                        <Tag color="orange">索引待更新</Tag>
                        <Button size="small" loading={indexing === ch.chapter_number} onClick={() => retryIndex(ch.chapter_number)}>重试索引</Button>
                      </>
                    )}
                    {(
                      <Button
                        size="small"
                        disabled={!!generating}
                        onClick={() => setMemoryChapter(ch.chapter_number)}
                      >
                        {ch.status === 'finalized' ? '核对 / 修正记忆' : '核对记忆并定稿'}
                      </Button>
                    )}
                  </Space>
                )
              })()
            }
          >
            {selectedChapterId ? (
              (() => {
                const ch = chapters.find((c) => c.id === selectedChapterId)
                if (!ch) return <div>章节不存在</div>
                if (chapterError) return <Alert type="error" message={chapterError} action={<Button onClick={() => setDetailRefresh(v => v + 1)}>重试</Button>} />
                if (ch.content === undefined) return <Spin tip="加载章节中…"><div style={{ minHeight: 160 }} /></Spin>
                const isGenerating = generating === `chapter:${ch.chapter_number}`
                return (
                  <Spin spinning={isGenerating} tip="AI 正在生成正文...">
                    {ch.status === 'needs_review' && (
                      <Alert type="warning" showIcon message="请核对本章正文和记忆，再确认定稿。正文已保留，无需重新生成。" style={{ marginBottom: 12 }} />
                    )}
                    <TextArea
                      value={ch.content || ''}
                      onChange={(e) => saveBody(ch, e.target.value)}
                      placeholder="正文内容将在这里显示，你也可以直接编辑..."
                      rows={20}
                      style={{ fontFamily: 'serif', fontSize: 15, lineHeight: 1.8 }}
                    />
                    {ch.content?.trim() && (
                      <ReviewPanel
                        key={ch.id}
                        novelId={id!}
                        chapterNum={ch.chapter_number}
                        canReview={!!taskConfigs.consistency}
                        onRevised={refreshChapters}
                        beforeAction={async () => { await Promise.all([bodySave.current,outlineSave.current]) }}
                      />
                    )}
                  </Spin>
                )
              })()
            ) : (
              <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>
                请先在上方选择或新建章节
              </div>
            )}
          </Card>
        </div>
        </div>
      ),
    },
  ]

  return (
    <div style={{ padding: 24, width: '100%' }}>
      {outlineError&&<Alert type="error" showIcon message={outlineError} description="输入仍保留在页面中。请先复制需要保留的修改，再重新载入服务器台本。" style={{marginBottom:16}} action={<Button onClick={()=>Modal.confirm({title:'放弃本地台本修改并重新载入？',okText:'重新载入',cancelText:'继续保留',onOk:async()=>{await outlineSave.current.catch(()=>{});outlineSave.current=Promise.resolve();outlineRevisions.current={};setOutlineError('');await refreshChapters()}})}>重新载入</Button>}/>}
      {outlineReview&&<OutlineReview key={`${id}:${outlineReview.num}`} novelId={id!} chapterNum={outlineReview.num} initialTab={outlineReview.tab}
        beforeAction={async()=>{await Promise.all([bodySave.current,outlineSave.current])}}
        onClose={()=>setOutlineReview(null)} onApplied={(outline,revision)=>{
          ++bodyEditSequence.current
          outlineRevisions.current[outlineReview.num]=revision
          setChapters(prev=>prev.map(c=>c.chapter_number===outlineReview.num?{...c,outline,outline_revision:revision}:c))
        }}/>}
      {memoryChapter !== null && <MemoryReview key={`${id}:${memoryChapter}`} novelId={id!} chapterNum={memoryChapter}
        canSuggest={!!taskConfigs.finalize} beforeAction={async () => { await Promise.all([bodySave.current,outlineSave.current]) }}
        onClose={() => setMemoryChapter(null)} onConfirmed={refreshChapters}
        onNext={chapters.some(c=>c.chapter_number===memoryChapter+1 && c.word_count>0) ? ()=>{
          const next=chapters.find(c=>c.chapter_number===memoryChapter+1)!
          setSelectedChapterId(next.id); setMemoryChapter(next.chapter_number)
        } : undefined} />}
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/fantasy')}>
          返回小说列表
        </Button>
        <Text strong style={{ fontSize: 18 }}>{novel?.title || '小说详情'}</Text>
        <Tag>{novel?.status}</Tag>
      </Space>

      <Tabs items={tabItems} activeKey={activeTab} onChange={setActiveTab} />

      {/* Doc Editor Modal */}
      <Modal
        title={`编辑 ${docLabels[docModalType] || docModalType}`}
        open={docModalOpen}
        onOk={saveDocContent}
        onCancel={() => setDocModalOpen(false)}
        width={800}
        okText="保存"
      >
        <TextArea
          value={docModalContent}
          onChange={(e) => setDocModalContent(e.target.value)}
          rows={20}
          style={{ fontFamily: 'monospace', fontSize: 13 }}
        />
      </Modal>

      {/* Character Add/Edit Modal */}
      <Modal
        title={charEdit?.index === null ? '添加角色' : '编辑角色'}
        open={!!charEdit}
        onOk={submitCharEdit}
        onCancel={closeCharEdit}
        width={700}
        okText="保存"
        okButtonProps={{ disabled: polishing }}
      >
        <Input
          value={charEdit?.name}
          onChange={(e) => setCharEdit((p) => p && { ...p, name: e.target.value })}
          placeholder="姓名"
          style={{ marginBottom: 12 }}
        />
        <Space style={{ marginBottom: 8 }}>
          <Button size="small" loading={polishing} onClick={polishCharacter}>AI 润色</Button>
          {preEditBody !== null && !polishing && (
            <Button
              size="small"
              type="link"
              onClick={() => {
                setCharEdit((p) => p && { ...p, body: preEditBody })
                setPreEditBody(null)
              }}
            >
              撤销润色
            </Button>
          )}
          <span style={{ color: '#999', fontSize: 12 }}>只理顺语言和结构，不新增设定；点「保存」才生效</span>
        </Space>
        <Spin spinning={polishing} tip="润色中...">
          <TextArea
            value={charEdit?.body}
            onChange={(e) => setCharEdit((p) => p && { ...p, body: e.target.value })}
            rows={14}
            style={{ fontSize: 14 }}
            disabled={polishing}
          />
        </Spin>
      </Modal>

      {/* Chapter View/Edit Modal */}
      <Modal
        title={viewingChapter ? `第 ${viewingChapter.chapter_number} 章 ${viewingChapter.title}` : '章节'}
        open={chapterViewOpen}
        onOk={saveChapterContent}
        onCancel={() => setChapterViewOpen(false)}
        width={900}
        okText="保存"
      >
        <TextArea
          value={chapterContent}
          onChange={(e) => setChapterContent(e.target.value)}
          rows={25}
          style={{ fontFamily: 'serif', fontSize: 15, lineHeight: 1.8 }}
        />
      </Modal>

      {/* LLM Config Editor Modal */}
      <Modal
        title={editingConfig ? '编辑 LLM 配置' : '添加 LLM 配置'}
        open={configModalOpen}
        onOk={saveConfig}
        onCancel={() => setConfigModalOpen(false)}
        width={600}
        okText="保存"
      >
        <Form form={configForm} layout="vertical">
          <Form.Item name="name" label="配置名称" rules={[{ required: true, message: '请输入配置名称' }]}>
            <Input placeholder="例如：DeepSeek V3" />
          </Form.Item>
          <Form.Item name="interface_format" label="接口类型" rules={[{ required: true }]}>
            <Select>
              {INTERFACE_FORMATS.map((f) => (
                <Select.Option key={f} value={f}>{f}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="base_url" label="Base URL" rules={[{ required: true, message: '请输入 Base URL' }]}>
            <Input placeholder="例如：https://api.deepseek.com" />
          </Form.Item>
          <Form.Item name="model_name" label="模型名称" rules={[{ required: true, message: '请输入模型名称' }]}>
            <Input placeholder="例如：deepseek-chat" />
          </Form.Item>
          <Form.Item name="api_key" label="API Key">
            <Input.Password placeholder={editingConfig ? '留空则不修改已保存的 Key' : 'sk-...'} />
          </Form.Item>
          <Form.Item name="temperature" label="Temperature">
            <Slider min={0} max={2} step={0.1} marks={{ 0: '0', 0.7: '0.7', 1: '1', 2: '2' }} />
          </Form.Item>
          <Form.Item name="max_tokens" label="Max Tokens">
            <InputNumber min={1} max={128000} step={1024} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="timeout" label="超时时间（秒）">
            <InputNumber min={10} max={3600} step={30} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Floating Log Button */}
      <Button
        type="primary"
        shape="circle"
        size="large"
        icon={<BugOutlined />}
        aria-label="LLM 调试"
        onClick={openLogDrawer}
        style={{
          position: 'fixed',
          right: 32,
          bottom: 32,
          zIndex: 999,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}
      />

      {/* LLM Log Drawer */}
      <Drawer
        title={
          <Space>
            <BugOutlined />
            <span>LLM 调试</span>
          </Space>
        }
        placement="right"
        width="min(760px, 100vw)"
        open={logDrawerOpen}
        onClose={closeLogDrawer}
        extra={debugTab==='logs'&&
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchLogs} loading={logsLoading}>刷新</Button>
            <Popconfirm title="确定清空所有日志？" onConfirm={clearLogs}>
              <Button icon={<ClearOutlined />} danger>清空</Button>
            </Popconfirm>
          </Space>
        }
      >
        <Tabs activeKey={debugTab} onChange={setDebugTab} items={[
          {key:'chat',label:'对话测试',children:<ChatTest key={id} novelId={id!}/>},
          {key:'logs',label:<Space>调用日志<Badge count={llmLogs.length} style={{backgroundColor:'#1890ff'}}/></Space>,children:logsLoading && llmLogs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : llmLogs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>暂无日志</div>
        ) : (
          <Collapse
            accordion
            style={{ background: '#fff' }}
          >
            {llmLogs.map((log) => {
              const statusConfig = {
                pending: { color: 'processing', icon: '⏳', label: '调用中' },
                success: { color: 'green', icon: '✓', label: '成功' },
                error: { color: 'red', icon: '✗', label: '失败' },
              }
              const cfg = statusConfig[log.status] || statusConfig.pending
              return (
                <Collapse.Panel
                  key={log.id}
                  header={
                    <Space>
                      <Tag color={cfg.color}>
                        {cfg.icon} {cfg.label}
                      </Tag>
                      <Tag color="blue">{log.task}</Tag>
                      <Tag>{log.model_name}</Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {log.status === 'pending' ? '...' : `${log.duration_ms}ms`}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </Text>
                    </Space>
                  }
                >
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontWeight: 500, marginBottom: 4, color: '#666' }}>System Prompt:</div>
                    <pre style={{
                      background: '#f5f5f5',
                      padding: 12,
                      borderRadius: 4,
                      fontSize: 12,
                      maxHeight: 200,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {log.system_prompt}
                    </pre>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontWeight: 500, marginBottom: 4, color: '#666' }}>User Prompt:</div>
                    <pre style={{
                      background: '#f5f5f5',
                      padding: 12,
                      borderRadius: 4,
                      fontSize: 12,
                      maxHeight: 200,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {log.user_prompt}
                    </pre>
                  </div>
                  {log.status === 'pending' ? (
                    <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>
                      <Spin size="small" /> 等待模型响应...
                    </div>
                  ) : log.error ? (
                    <div>
                      <div style={{ fontWeight: 500, marginBottom: 4, color: '#ff4d4f' }}>Error:</div>
                      <pre style={{
                        background: '#fff2f0',
                        padding: 12,
                        borderRadius: 4,
                        fontSize: 12,
                        color: '#ff4d4f',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}>
                        {log.error}
                      </pre>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontWeight: 500, marginBottom: 4, color: '#666' }}>Response:</div>
                      <pre style={{
                        background: '#f6ffed',
                        padding: 12,
                        borderRadius: 4,
                        fontSize: 12,
                        maxHeight: 300,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}>
                        {log.response || '(empty)'}
                      </pre>
                    </div>
                  )}
                </Collapse.Panel>
              )
            })}
          </Collapse>
        )},
        ]}/>
      </Drawer>
    </div>
  )
}
