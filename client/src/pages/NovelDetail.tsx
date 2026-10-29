import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Tabs, Card, Form, Input, InputNumber, Select, Button,
  Modal, message, Spin, Space, Typography, Tag,
  Table, Popconfirm, Divider, Badge, Slider, Drawer, Collapse,
  Upload, ConfigProvider, theme,
} from 'antd'
import {
  SettingOutlined,
  FileTextOutlined,
  PlusOutlined, EditOutlined, DeleteOutlined,
  ApiOutlined, BugOutlined, ClearOutlined, ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import api from '../api'
import OutlineReview from '../components/OutlineReview'
import ChatTest from '../components/ChatTest'
import WritingDesk from '../components/WritingDesk'

const { TextArea } = Input

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
  architecture: { label: '文风分析模型', desc: '从范文提取写作风格' },
  chapter: { label: '起草模型', desc: '逐章正文生成（调用最频繁）' },
  consistency: { label: '审校模型', desc: '自动核验连续性与知情边界；审稿时检查台本和文笔' },
}

const INTERFACE_FORMATS = ['OpenAI', 'DeepSeek', 'Ollama', 'Gemini', 'Azure OpenAI', 'ML Studio']

export default function NovelDetail() {
  const [outlineReview,setOutlineReview] = useState<{num:number;tab:'review'|'versions'}|null>(null)

  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [novel, setNovel] = useState<any>(null)
  const [activeTab, setActiveTab] = useState('writing')
  const [detailRefresh, setDetailRefresh] = useState(0)
  const [allConfigs, setAllConfigs] = useState<LLMConfig[]>([])
  const [taskConfigs, setTaskConfigs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  // LLM config editor
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const [editingConfig, setEditingConfig] = useState<LLMConfig | null>(null)
  const [configForm] = Form.useForm()

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

  useEffect(() => {
    if (!id) return
    Promise.all([
      api.get(`/novels/${id}`),
      api.get('/llm-configs'),
    ]).then(([n, l]) => {
      setNovel(n.data)
      setAllConfigs(l.data)
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
    await refreshWritingDesk()
  }

  const extractStyleGuide = async (text: string) => {
    if (!text || text.trim().length < 100) {
      message.error('范文内容太短，请至少提供100字以上的文本')
      return false
    }
    if (!taskConfigs.architecture) {
      message.error('请先在模型管理中选择文风分析模型')
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

  const refreshWritingDesk = async () => { setDetailRefresh(value => value + 1) }

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
      label: <span><SettingOutlined /> 作品设置</span>,
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
      label: <span><ApiOutlined /> 模型管理</span>,
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
      key: 'style',
      label: <span><FileTextOutlined /> 文风与范文</span>,
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
              <div style={{ fontSize: 13, color: '#8e929f', marginBottom: 8 }}>
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
                    color: '#aeb0b8',
                    background: '#1d2b20',
                    padding: 16,
                    borderRadius: 6,
                    border: '1px solid #39553a',
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
            <div style={{ fontSize: 13, color: '#8e929f', marginBottom: 8 }}>
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

  ]

  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: {colorPrimary: '#d9bd80', colorBgBase: '#15171c', colorTextBase: '#e8e4db'} }}>
    <div className="novel-workspace">
      {outlineReview && <OutlineReview key={`${id}:${outlineReview.num}`} novelId={id!} chapterNum={outlineReview.num} initialTab={outlineReview.tab}
        beforeAction={async () => {}} onClose={() => setOutlineReview(null)} onApplied={() => void refreshWritingDesk()} />}
      <WritingDesk key={id} novelId={id!} novelTitle={novel?.title || '我的小说'}
        refreshVersion={detailRefresh} canReindex={Boolean(embeddingConfig)} modelsVersion={JSON.stringify(allConfigs)}
        onBack={() => navigate('/fantasy')} onOpenTool={setActiveTab} onDebug={openLogDrawer}
        onOutlineReview={num => setOutlineReview({num,tab:'review'})}
        onOutlineVersions={num => setOutlineReview({num,tab:'versions'})} />
      <Drawer className="workspace-tools" title={tabItems.find(item => item.key === activeTab)?.label}
        width="min(960px, 100vw)"
        open={activeTab !== 'writing'} onClose={() => setActiveTab('writing')}
        extra={<Button onClick={() => setActiveTab('writing')}>返回写作</Button>}>
        {tabItems.find(item => item.key === activeTab)?.children}
      </Drawer>

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
            <Input autoComplete="off" placeholder="例如：deepseek-chat" />
          </Form.Item>
          <Form.Item name="api_key" label="API Key">
            <Input.Password autoComplete="new-password" placeholder={editingConfig ? '留空则不修改已保存的 Key' : 'sk-...'} />
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
            style={{ background: '#1b1d23' }}
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
                    <div style={{ fontWeight: 500, marginBottom: 4, color: '#8e929f' }}>System Prompt:</div>
                    <pre style={{
                      background: '#121419',
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
                    <div style={{ fontWeight: 500, marginBottom: 4, color: '#8e929f' }}>User Prompt:</div>
                    <pre style={{
                      background: '#121419',
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
                        background: '#2b1d20',
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
                      <div style={{ fontWeight: 500, marginBottom: 4, color: '#8e929f' }}>Response:</div>
                      <pre style={{
                        background: '#1d2b20',
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
    </ConfigProvider>
  )
}
