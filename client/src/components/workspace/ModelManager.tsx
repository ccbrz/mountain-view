import { useEffect, useState } from 'react'
import { Button, Form, Input, InputNumber, Modal, Select, Slider, Space, Table, Tag, Tooltip, message } from 'antd'
import { ApiOutlined, DeleteOutlined, EditOutlined, LockOutlined, PlusOutlined } from '@ant-design/icons'
import api from '../../api'
import { useAuth } from '../../context/AuthContext'

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
  created_by: string
}

const INTERFACE_FORMATS = ['OpenAI', 'DeepSeek', 'Ollama', 'Gemini', 'Azure OpenAI', 'ML Studio', 'NovelAI Image']

/** Shared model configurations. Only the creator or an admin can change, test or delete one. */
export default function ModelManager({ onChange }: { onChange: () => void }) {
  const { user } = useAuth()
  const [configs, setConfigs] = useState<LLMConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<LLMConfig | 'new' | null>(null)
  const [testing, setTesting] = useState<number | null>(null)
  const [form] = Form.useForm()
  const canManage = (config: LLMConfig) => user?.role === 'admin' || config.created_by === user?.username

  const fetchConfigs = async () => {
    try {
      setConfigs((await api.get('/llm-configs')).data)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void fetchConfigs()
  }, [])

  const openEditor = (config: LLMConfig | 'new') => {
    form.resetFields() // The API never returns keys; resetting avoids carrying a previously typed one over.
    form.setFieldsValue(
      config === 'new' ? { interface_format: 'OpenAI', temperature: 0.7, max_tokens: 4096, timeout: 600 } : config,
    )
    setEditing(config)
  }

  const save = async () => {
    const values = await form.validateFields()
    try {
      if (editing === 'new') await api.post('/llm-configs', values)
      else await api.put(`/llm-configs/${(editing as LLMConfig).id}`, values)
      message.success(editing === 'new' ? '模型配置已创建' : '模型配置已更新')
      setEditing(null)
      await fetchConfigs()
      onChange()
    } catch (err: any) {
      message.error(err.response?.data?.message || '保存失败')
    }
  }

  const remove = (config: LLMConfig) =>
    Modal.confirm({
      title: `删除模型配置「${config.name}」？`,
      content: '正在使用它的作品需要在写作台重新选择模型。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        await api.delete(`/llm-configs/${config.id}`)
        message.success('模型配置已删除')
        await fetchConfigs()
        onChange()
      },
    })

  const test = async (config: LLMConfig) => {
    setTesting(config.id)
    try {
      const { data } = await api.post(`/llm-configs/${config.id}/test`)
      if (data.success) message.success(data.message)
      else message.error(data.message)
    } catch (err: any) {
      message.error('测试失败：' + (err.response?.data?.message || err.message))
    } finally {
      setTesting(null)
    }
  }

  const original = editing && editing !== 'new' ? editing : null
  const baseUrl = Form.useWatch('base_url', form)
  const urlChanged = Boolean(original?.has_key && baseUrl !== undefined && baseUrl !== original.base_url)

  return (
    <div className="tool-stack">
      <section className="tool-section">
        <div className="tool-section-heading">
          <div>
            <h3>模型配置</h3>
            <p>所有作者共享可选的模型列表；Key 只保存在服务器，不会返回到页面。你只能修改自己创建的配置。</p>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor('new')}>
            添加配置
          </Button>
        </div>
        <Table
          dataSource={configs}
          rowKey="id"
          loading={loading}
          pagination={false}
          size="middle"
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (name: string, record) => (
                <div>
                  <strong>{name}</strong>
                  <div className="tool-cell-sub">{record.model_name}</div>
                </div>
              ),
            },
            { title: 'Base URL', dataIndex: 'base_url', ellipsis: true },
            {
              title: 'Key',
              dataIndex: 'has_key',
              width: 84,
              render: (hasKey: boolean) =>
                hasKey ? <Tag color="success">已配置</Tag> : <Tag color="warning">未配置</Tag>,
            },
            { title: '创建者', dataIndex: 'created_by', width: 100 },
            {
              title: '操作',
              key: 'action',
              width: 150,
              render: (_: unknown, record: LLMConfig) =>
                canManage(record) ? (
                  <Space size={2}>
                    <Tooltip title={record.interface_format === 'NovelAI Image' ? '校验生图账号' : '测试对话'}>
                      <Button
                        type="text"
                        size="small"
                        aria-label={`测试 ${record.name}`}
                        icon={<ApiOutlined />}
                        loading={testing === record.id}
                        onClick={() => test(record)}
                      />
                    </Tooltip>
                    <Tooltip title="编辑">
                      <Button
                        type="text"
                        size="small"
                        aria-label={`编辑 ${record.name}`}
                        icon={<EditOutlined />}
                        onClick={() => openEditor(record)}
                      />
                    </Tooltip>
                    <Tooltip title="删除">
                      <Button
                        type="text"
                        size="small"
                        danger
                        aria-label={`删除 ${record.name}`}
                        icon={<DeleteOutlined />}
                        onClick={() => remove(record)}
                      />
                    </Tooltip>
                  </Space>
                ) : (
                  <Tooltip title={`由 ${record.created_by || '其他用户'} 管理`}>
                    <Tag icon={<LockOutlined />} bordered={false}>
                      只读
                    </Tag>
                  </Tooltip>
                ),
            },
          ]}
        />
      </section>

      <Modal
        title={editing === 'new' ? '添加模型配置' : '编辑模型配置'}
        open={Boolean(editing)}
        onOk={save}
        onCancel={() => setEditing(null)}
        width={600}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 16 }}>
          <Form.Item name="name" label="配置名称" rules={[{ required: true, message: '请输入配置名称' }]}>
            <Input placeholder="例如：DeepSeek V3" />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="interface_format" label="接口类型" style={{ width: 180 }}>
              <Select options={INTERFACE_FORMATS.map(value => ({ value }))} />
            </Form.Item>
            <Form.Item
              name="model_name"
              label="模型名称"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请输入模型名称' }]}
            >
              <Input autoComplete="off" placeholder="例如：deepseek-chat" />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="base_url" label="Base URL" rules={[{ required: true, message: '请输入 Base URL' }]}>
            <Input placeholder="例如：https://api.deepseek.com/v1" />
          </Form.Item>
          <Form.Item
            name="api_key"
            label="API Key"
            extra={urlChanged ? '已修改 Base URL：需要重新填写 Key，原 Key 不会发送到新地址。' : undefined}
            rules={[{ required: urlChanged, message: '修改 Base URL 时需要重新填写 API Key' }]}
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={original ? (original.has_key ? '留空则保留已保存的 Key' : '尚未配置 Key') : 'sk-...'}
            />
          </Form.Item>
          <Form.Item name="temperature" label="Temperature">
            <Slider min={0} max={2} step={0.05} marks={{ 0: '0', 0.7: '0.7', 1: '1', 2: '2' }} />
          </Form.Item>
          <Space size="large">
            <Form.Item name="max_tokens" label="Max Tokens">
              <InputNumber min={1} max={128000} step={1024} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="timeout" label="超时">
              <InputNumber min={10} max={3600} step={30} addonAfter="秒" style={{ width: 160 }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}
