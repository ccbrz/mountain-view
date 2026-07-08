import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Tabs, Card, Form, Input, InputNumber, Select, Button,
  Modal, message, Spin, Space, Typography, Tag,
  Table, Popconfirm, Divider, Badge, Slider, Drawer, Collapse,
  Upload,
} from 'antd'
import {
  ArrowLeftOutlined, SettingOutlined, BookOutlined, OrderedListOutlined,
  FileTextOutlined, TeamOutlined, CompressOutlined, ThunderboltOutlined,
  PlayCircleOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  ApiOutlined, BugOutlined, ClearOutlined, ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import api from '../api'
import { useAuth } from '../context/AuthContext'

const { TextArea } = Input
const { Text } = Typography

interface LLMConfig {
  id: number
  name: string
  interface_format: string
  base_url: string
  model_name: string
  api_key: string
  temperature: number
  max_tokens: number
  timeout: number
}

interface Chapter {
  id: number
  chapter_number: number
  title: string
  outline: string
  content: string
  status: string
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
  architecture: { label: '架构模型', desc: '核心种子 / 角色 / 世界观 / 情节' },
  blueprint: { label: '蓝图模型', desc: '生成章节大纲' },
  chapter: { label: '起草模型', desc: '逐章正文生成（调用最频繁）' },
  finalize: { label: '终稿模型', desc: '更新摘要 / 角色状态' },
  consistency: { label: '审校模型', desc: '一致性检查' },
  rerank: { label: '重排模型', desc: '知识过滤重排（选个小模型省钱）' },
}

const INTERFACE_FORMATS = ['OpenAI', 'DeepSeek', 'Ollama', 'Gemini', 'Azure OpenAI', 'ML Studio']

export default function NovelDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [novel, setNovel] = useState<any>(null)
  const [docs, setDocs] = useState<Record<string, string>>({})
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [allConfigs, setAllConfigs] = useState<LLMConfig[]>([])
  const [taskConfigs, setTaskConfigs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState<string | null>(null)

  // doc editor
  const [docModalOpen, setDocModalOpen] = useState(false)
  const [docModalType, setDocModalType] = useState('')
  const [docModalContent, setDocModalContent] = useState('')

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

  // consistency check
  const [consistencyResult, setConsistencyResult] = useState<{ result: string; has_conflict: boolean } | null>(null)

  // settings form
  const [settingsForm] = Form.useForm()

  // embedding config
  const [embeddingConfig, setEmbeddingConfig] = useState('')

  // LLM log viewer
  const [logDrawerOpen, setLogDrawerOpen] = useState(false)
  const [llmLogs, setLlmLogs] = useState<LLMCallLog[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const logPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // chapter editor (three-column layout)
  const [selectedChapterId, setSelectedChapterId] = useState<number | null>(null)
  const [columnWidths, setColumnWidths] = useState([20, 30, 50]) // 默认比例 2:3:5
  const [dragging, setDragging] = useState<number | null>(null)

  const handleMouseDown = (index: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(index)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragging === null) return
    
    const container = e.currentTarget
    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const totalWidth = rect.width
    
    if (dragging === 0) {
      // 第一个分隔条：调整章节和台本的宽度
      const newWidths = [...columnWidths]
      const leftPercent = Math.max(10, Math.min(60, (x / totalWidth) * 100))
      newWidths[0] = leftPercent
      newWidths[1] = 100 - leftPercent - newWidths[2]
      if (newWidths[1] < 10) {
        newWidths[1] = 10
        newWidths[0] = 100 - 10 - newWidths[2]
      }
      setColumnWidths(newWidths)
    } else if (dragging === 1) {
      // 第二个分隔条：调整台本和正文的宽度
      const newWidths = [...columnWidths]
      const rightPercent = Math.max(10, Math.min(80, ((totalWidth - x) / totalWidth) * 100))
      newWidths[2] = rightPercent
      newWidths[1] = 100 - newWidths[0] - rightPercent
      if (newWidths[1] < 10) {
        newWidths[1] = 10
        newWidths[2] = 100 - newWidths[0] - 10
      }
      setColumnWidths(newWidths)
    }
  }

  const handleMouseUp = () => {
    setDragging(null)
  }

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
    fetchLogs()
    if (logPollRef.current) clearInterval(logPollRef.current)
    logPollRef.current = setInterval(fetchLogs, 3000)
  }

  const closeLogDrawer = () => {
    setLogDrawerOpen(false)
    if (logPollRef.current) {
      clearInterval(logPollRef.current)
      logPollRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      if (logPollRef.current) clearInterval(logPollRef.current)
    }
  }, [])

  const saveSettings = async () => {
    const vals = await settingsForm.validateFields()
    await api.put(`/novels/${id}`, { ...vals, llm_config: JSON.stringify(taskConfigs) })
    message.success('已保存')
    const n = await api.get(`/novels/${id}`)
    setNovel(n.data)
  }

  const saveArchitectureInput = async () => {
    setSavingInput(true)
    try {
      await api.put(`/novels/${id}/docs/architecture`, { content: architectureInput })
      setDocs((prev) => ({ ...prev, architecture: architectureInput }))
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

  const handleEmbeddingConfigChange = async (configName: string) => {
    setEmbeddingConfig(configName)
    if (id) {
      await api.put(`/novels/${id}`, { embedding_config: configName })
    }
  }

  const taskForAction = (action: string): string => {
    if (action === 'architecture') return 'architecture'
    if (action === 'blueprint') return 'blueprint'
    if (action === 'finalize') return 'finalize'
    return 'chapter'
  }

  const callGenerate = async (action: string, extra?: string, userInput?: string) => {
    const task = taskForAction(action)
    const cfgName = taskConfigs[task]
    if (!cfgName) return message.error(`请先在设置中选择「${TASK_LABELS[task]?.label || task}」对应的 LLM 配置`)
    const cfg = allConfigs.find((c) => c.name === cfgName)
    if (!cfg?.api_key) return message.error(`"${cfgName}" 未配置 API Key`)

    setGenerating(extra ? `${action}:${extra}` : action)
    try {
      await api.put(`/novels/${id}`, { llm_config: JSON.stringify(taskConfigs) })

      const url = extra
        ? `/novels/${id}/generate/${action}/${extra}`
        : `/novels/${id}/generate/${action}`
      const res = await api.post(url, { llm_config: cfgName, user_input: userInput })
      message.success(res.data.message)

      const [d, c] = await Promise.all([
        api.get(`/novels/${id}/docs`),
        api.get(`/novels/${id}/chapters`),
      ])
      setDocs(d.data)
      setChapters(c.data)
      if (action === 'architecture' && d.data.architecture) {
        setArchitectureInput(d.data.architecture)
      }
      const n = await api.get(`/novels/${id}`)
      setNovel(n.data)
    } catch (err: any) {
      message.error(err.response?.data?.message || '生成失败')
    } finally {
      setGenerating(null)
    }
  }

  const openDocEditor = (type: string) => {
    setDocModalType(type)
    const labels: Record<string, string> = {
      architecture: '小说架构', blueprint: '章节蓝图',
      characters: '角色状态', summary: '全局摘要',
    }
    setDocModalContent(docs[type] || `（${labels[type] || type} 尚未生成）`)
    setDocModalOpen(true)
  }

  const saveDocContent = async () => {
    await api.put(`/novels/${id}/docs/${docModalType}`, { content: docModalContent })
    message.success('已保存')
    setDocModalOpen(false)
    setDocs((prev) => ({ ...prev, [docModalType]: docModalContent }))
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
    await api.put(`/novels/${id}/chapters/${viewingChapter.chapter_number}`, { content: chapterContent })
    message.success('章节已保存')
    setChapterViewOpen(false)
    const c = await api.get(`/novels/${id}/chapters`)
    setChapters(c.data)
  }

  const addChapter = async () => {
    const newChapterNum = chapters.length > 0 ? Math.max(...chapters.map(c => c.chapter_number)) + 1 : 1
    try {
      await api.post(`/novels/${id}/chapters`, {
        chapter_number: newChapterNum,
        title: `第${newChapterNum}章`,
        outline: '',
        content: ''
      })
      message.success('章节已创建')
      const c = await api.get(`/novels/${id}/chapters`)
      setChapters(c.data)
      // 自动选中新建的章节
      if (c.data.length > 0) {
        const newChapter = c.data.find((ch: Chapter) => ch.chapter_number === newChapterNum)
        if (newChapter) {
          setSelectedChapterId(newChapter.id)
        }
      }
    } catch (err: any) {
      message.error('创建章节失败: ' + (err.response?.data?.message || err.message))
    }
  }

  const deleteChapter = async (chapterId: number) => {
    try {
      await api.delete(`/novels/${id}/chapters/${chapterId}`)
      message.success('章节已删除')
      const c = await api.get(`/novels/${id}/chapters`)
      setChapters(c.data)
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
      // 获取所有章节的完整内容
      const chapterContents = await Promise.all(
        chapters.map(async (ch) => {
          const res = await api.get(`/novels/${id}/chapters/${ch.chapter_number}`)
          return res.data
        })
      )

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

  const runConsistencyCheck = async (chapterNum: number) => {
    setGenerating(`consistency:${chapterNum}`)
    setConsistencyResult(null)
    try {
      const res = await api.post(`/novels/${id}/generate/consistency/${chapterNum}`, {
        llm_config: taskConfigs.consistency
      })
      setConsistencyResult({
        result: res.data.result,
        has_conflict: res.data.has_conflict
      })
      message.success(res.data.message)
    } catch (err: any) {
      message.error('审校失败: ' + (err.response?.data?.message || err.message))
    } finally {
      setGenerating(null)
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

  const testConfig = async (configId: number) => {
    try {
      const res = await api.post(`/llm-configs/${configId}/test`)
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
    architecture: '小说架构（核心种子 / 角色 / 世界观 / 情节）',
    characters: '角色状态追踪',
    summary: '全局摘要',
  }

  const configColumns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '模型', dataIndex: 'model_name', key: 'model_name' },
    { title: 'Base URL', dataIndex: 'base_url', key: 'base_url', ellipsis: true },
    {
      title: 'Key', dataIndex: 'api_key', key: 'api_key', width: 60,
      render: (key: string) => key ? <Tag color="green">✓</Tag> : <Tag color="red">✗</Tag>,
    },
    {
      title: '操作', key: 'action', width: 200,
      render: (_: unknown, record: LLMConfig) => (
        <Space>
          <Button type="link" size="small" icon={<ApiOutlined />} onClick={() => testConfig(record.id)}>测试</Button>
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

            <Space>
              <Button type="primary" onClick={saveSettings}>保存设置</Button>
              <Button
                icon={<OrderedListOutlined />}
                loading={generating === 'blueprint'}
                onClick={() => callGenerate('blueprint')}
                disabled={!taskConfigs.blueprint || !docs.architecture}
              >
                生成蓝图
              </Button>

            </Space>
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
                      {c.name} ({c.model_name}) {c.api_key ? '' : '⚠️ 未配置 Key'}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            ))}
          </Card>

          <Card title="Embedding 配置">
            <Form.Item label="Embedding 模型" help="终稿章节时会调用此模型生成向量，用于后续章节的语义检索" style={{ marginBottom: 0 }}>
              <Select
                value={embeddingConfig}
                onChange={handleEmbeddingConfigChange}
                placeholder="选择 Embedding 模型"
                style={{ maxWidth: 400 }}
                allowClear
              >
                {allConfigs.map((c) => (
                  <Select.Option key={c.name} value={c.name}>
                    {c.name} ({c.model_name}) {c.api_key ? '' : '⚠️ 未配置 Key'}
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
            title="小说架构（核心种子 / 角色 / 世界观 / 情节）"
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
              粘贴一段范文原文（1000 字以内），生成章节时会直接注入 User Prompt 末尾作为 few-shot 示范：
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
    ...[
      { key: 'characters', label: '角色', icon: <TeamOutlined /> },
      { key: 'summary', label: '摘要', icon: <CompressOutlined /> },
    ].map((dt) => ({
      key: dt.key,
      label: <span>{dt.icon} {dt.label}</span>,
      children: (
        <Card
          title={docLabels[dt.key]}
          extra={<Button onClick={() => openDocEditor(dt.key)}>编辑</Button>}
        >
          <pre style={{
            whiteSpace: 'pre-wrap', fontFamily: 'inherit',
            fontSize: 14, lineHeight: 1.8, color: '#333',
            minHeight: 200,
          }}>
            {docs[dt.key] || `（${docLabels[dt.key]} 尚未生成）`}
          </pre>
        </Card>
      ),
    })),
    {
      key: 'chapters',
      label: <span><FileTextOutlined /> 章节</span>,
      children: (
        <div 
          className="responsive-editor-panel"
          style={{ display: 'flex', minHeight: '600px', position: 'relative', userSelect: dragging !== null ? 'none' : 'auto' }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* 左侧：章节列表 */}
          <Card
            title={`章节 (${chapters.length})`}
            style={{ width: `${columnWidths[0]}%`, flexShrink: 0 }}
            bodyStyle={{ padding: 0, overflow: 'auto', maxHeight: '600px' }}
            extra={
              <Space>
                <Button
                  size="small"
                  onClick={exportChapters}
                >
                  导出
                </Button>
                <Button
                  type="primary"
                  size="small"
                  onClick={addChapter}
                >
                  新建
                </Button>
              </Space>
            }
          >
            {chapters.map((ch) => (
              <div
                key={ch.id}
                onClick={() => setSelectedChapterId(ch.id)}
                style={{
                  padding: '12px 16px',
                  cursor: 'pointer',
                  background: selectedChapterId === ch.id ? '#e6f7ff' : 'transparent',
                  borderLeft: selectedChapterId === ch.id ? '3px solid #1890ff' : '3px solid transparent',
                  borderBottom: '1px solid #f0f0f0',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, marginBottom: 4 }}>
                    第 {ch.chapter_number} 章
                  </div>
                  <div style={{ fontSize: 12, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ch.title || '（未命名）'}
                  </div>
                  {ch.word_count > 0 && (
                    <div style={{ fontSize: 11, color: '#52c41a', marginTop: 4 }}>
                      ✓ {ch.word_count} 字
                    </div>
                  )}
                </div>
                <Popconfirm
                  title="确定删除该章节？"
                  onConfirm={(e) => {
                    e?.stopPropagation()
                    deleteChapter(ch.id)
                  }}
                  onCancel={(e) => e?.stopPropagation()}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    onClick={(e) => e.stopPropagation()}
                    style={{ flexShrink: 0 }}
                  >
                    ×
                  </Button>
                </Popconfirm>
              </div>
            ))}
            {chapters.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: '#999' }}>
                暂无章节，点击"新建"创建
              </div>
            )}
          </Card>

          {/* 第一个分隔条 */}
          <div
            onMouseDown={handleMouseDown(0)}
            style={{
              width: 8,
              cursor: 'col-resize',
              background: dragging === 0 ? '#1890ff' : '#f0f0f0',
              transition: dragging === 0 ? 'none' : 'background 0.2s',
              flexShrink: 0,
            }}
          />

          {/* 中间：台本编辑区 */}
          <Card
            title="台本"
            style={{ width: `${columnWidths[1]}%`, flexShrink: 0 }}
            bodyStyle={{ padding: 16 }}
          >
            {selectedChapterId ? (
              (() => {
                const ch = chapters.find((c) => c.id === selectedChapterId)
                if (!ch) return <div>章节不存在</div>
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
                      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>台本（剧情梗概）</div>
                      <TextArea
                        value={ch.outline || ''}
                        onChange={async (e) => {
                          const newOutline = e.target.value
                          setChapters((prev) => prev.map((c) => c.id === ch.id ? { ...c, outline: newOutline } : c))
                          await api.put(`/novels/${id}/chapters/${ch.chapter_number}`, { outline: newOutline })
                        }}
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
                请从左侧选择章节
              </div>
            )}
          </Card>

          {/* 第二个分隔条 */}
          <div
            onMouseDown={handleMouseDown(1)}
            style={{
              width: 8,
              cursor: 'col-resize',
              background: dragging === 1 ? '#1890ff' : '#f0f0f0',
              transition: dragging === 1 ? 'none' : 'background 0.2s',
              flexShrink: 0,
            }}
          />

          {/* 右侧：正文展示区 */}
          <Card
            title="正文"
            style={{ width: `${columnWidths[2]}%` }}
            bodyStyle={{ padding: 16 }}
            extra={
              selectedChapterId && (() => {
                const ch = chapters.find((c) => c.id === selectedChapterId)
                if (!ch || ch.word_count === 0) return null
                return (
                  <Space>
                    <Button
                      size="small"
                      loading={generating === `consistency:${ch.chapter_number}`}
                      onClick={() => runConsistencyCheck(ch.chapter_number)}
                      disabled={!taskConfigs.consistency}
                    >
                      审校
                    </Button>
                    {ch.status !== 'finalized' && (
                      <Button
                        size="small"
                        loading={generating === `finalize:${ch.chapter_number}`}
                        onClick={() => callGenerate('finalize', String(ch.chapter_number))}
                      >
                        终稿
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
                const isGenerating = generating === `chapter:${ch.chapter_number}`
                return (
                  <Spin spinning={isGenerating} tip="AI 正在生成正文...">
                    <TextArea
                      value={ch.content || ''}
                      onChange={async (e) => {
                        const newContent = e.target.value
                        setChapters((prev) => prev.map((c) => c.id === ch.id ? { ...c, content: newContent } : c))
                        await api.put(`/novels/${id}/chapters/${ch.chapter_number}`, { content: newContent })
                      }}
                      placeholder="正文内容将在这里显示，你也可以直接编辑..."
                      rows={20}
                      style={{ fontFamily: 'serif', fontSize: 15, lineHeight: 1.8 }}
                    />
                    {consistencyResult && (
                      <div style={{ marginTop: 16 }}>
                        <Divider style={{ margin: '12px 0' }} />
                        <div style={{ 
                          padding: 12, 
                          background: consistencyResult.has_conflict ? '#fff2f0' : '#f6ffed',
                          border: `1px solid ${consistencyResult.has_conflict ? '#ffccc7' : '#b7eb8f'}`,
                          borderRadius: 4
                        }}>
                          <div style={{ fontWeight: 500, marginBottom: 8 }}>
                            {consistencyResult.has_conflict ? '⚠️ 发现冲突' : '✓ 无明显冲突'}
                          </div>
                          <pre style={{ 
                            whiteSpace: 'pre-wrap', 
                            fontFamily: 'inherit', 
                            fontSize: 13, 
                            margin: 0,
                            color: '#333'
                          }}>
                            {consistencyResult.result}
                          </pre>
                        </div>
                      </div>
                    )}
                  </Spin>
                )
              })()
            ) : (
              <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>
                请从左侧选择章节
              </div>
            )}
          </Card>
        </div>
      ),
    },
  ]

  return (
    <div style={{ padding: 24, width: '100%' }}>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/fantasy')}>
          返回小说列表
        </Button>
        <Text strong style={{ fontSize: 18 }}>{novel?.title || '小说详情'}</Text>
        <Tag>{novel?.status}</Tag>
      </Space>

      <Tabs items={tabItems} />

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
            <Input.Password placeholder="sk-..." />
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
            <span>LLM 调用日志</span>
            <Badge count={llmLogs.length} style={{ backgroundColor: '#1890ff' }} />
          </Space>
        }
        placement="right"
        width={720}
        open={logDrawerOpen}
        onClose={closeLogDrawer}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchLogs} loading={logsLoading}>刷新</Button>
            <Popconfirm title="确定清空所有日志？" onConfirm={clearLogs}>
              <Button icon={<ClearOutlined />} danger>清空</Button>
            </Popconfirm>
          </Space>
        }
      >
        {logsLoading && llmLogs.length === 0 ? (
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
        )}
      </Drawer>
    </div>
  )
}
