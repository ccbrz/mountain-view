import { useState, useEffect } from 'react'
import {
  Card, Input, Button, Modal, Form, message, Space, Typography,
  Empty, Spin, Popconfirm, Tag, Select,
} from 'antd'
import { PlusOutlined, SearchOutlined, EditOutlined, DeleteOutlined, RightOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import api from '../api'

const { Text, Paragraph } = Typography

interface Novel {
  id: number
  title: string
  content: string
  creator_username: string
  genre: string
  status: string
  num_chapters: number
  word_number: number
  created_at: string
  updated_at: string
}

export default function FantasyWriter() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [novels, setNovels] = useState<Novel[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingNovel, setEditingNovel] = useState<Novel | null>(null)
  const [form] = Form.useForm()

  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(fetchNovels, 300)
    return () => clearTimeout(timer)
  }, [search])

  const fetchNovels = async () => {
    try {
      const res = await api.get('/novels', { params: search ? { search } : {} })
      setNovels(res.data)
    } catch {
      message.error('获取小说列表失败')
    } finally {
      setLoading(false)
    }
  }

  const openCreate = () => {
    setEditingNovel(null)
    form.resetFields()
    setModalOpen(true)
  }

  const openEdit = (novel: Novel) => {
    setEditingNovel(novel)
    form.setFieldsValue(novel)
    setModalOpen(true)
  }

  const handleSave = async () => {
    const values = await form.validateFields()
    if (editingNovel) {
      await api.put(`/novels/${editingNovel.id}`, values)
      message.success('小说已更新')
    } else {
      await api.post('/novels', values)
      message.success('小说已创建')
    }
    setModalOpen(false)
    fetchNovels()
  }

  const handleDelete = async (id: number) => {
    await api.delete(`/novels/${id}`)
    message.success('小说已删除')
    fetchNovels()
  }

  const canEdit = (novel: Novel) => isAdmin || novel.creator_username === user?.username
  const canDelete = canEdit

  const statusColors: Record<string, string> = {
    created: 'default',
    architecture_done: 'blue',
    blueprint_done: 'cyan',
    in_progress: 'processing',
    completed: 'success',
  }

  return (
    <>
      <Card style={{ marginBottom: 16 }} bodyStyle={{ padding: '12px 24px' }}>
        <div className="responsive-search-bar" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Input
            placeholder="搜索小说标题..."
            prefix={<SearchOutlined />}
            style={{ maxWidth: 320, width: '100%' }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>创建小说</Button>
        </div>
      </Card>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : novels.length === 0 ? (
        <Card><Empty description={search ? '未找到匹配的小说' : '还没有小说，点击上方按钮创建'} /></Card>
      ) : (
        novels.map((novel) => (
          <Card
            key={novel.id}
            size="small"
            style={{ marginBottom: 12, cursor: 'pointer' }}
            hoverable
            onClick={() => navigate(`/novels/${novel.id}`)}
            title={
              <Space>
                <Text strong>{novel.title}</Text>
                {novel.genre && <Tag>{novel.genre}</Tag>}
                <Tag color={statusColors[novel.status] || 'default'}>{novel.status}</Tag>
                {isAdmin && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    by {novel.creator_username}
                  </Text>
                )}
              </Space>
            }
            extra={
              <Space onClick={(e) => e.stopPropagation()}>
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(novel)}>
                  设置
                </Button>
                {canDelete(novel) && (
                  <Popconfirm title="确定删除？" onConfirm={() => handleDelete(novel.id)}>
                    <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                )}
              </Space>
            }
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {novel.num_chapters}章 · 每章{novel.word_number}字 · 更新于 {new Date(novel.updated_at).toLocaleString('zh-CN')}
                </Text>
              </div>
              <Button type="text" icon={<RightOutlined />} />
            </div>
          </Card>
        ))
      )}

      <Modal
        title={editingNovel ? '编辑小说' : '创建小说'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        width={500}
        okText={editingNovel ? '保存' : '创建'}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入小说标题' }]}>
            <Input placeholder="小说标题" />
          </Form.Item>
          <Form.Item name="genre" label="类型">
            <Input placeholder="玄幻 / 科幻 / 悬疑 / 言情..." />
          </Form.Item>
          <Form.Item name="num_chapters" label="章节数" initialValue={10}>
            <Select>
              {[5, 10, 15, 20, 30, 50, 100].map((n) => (
                <Select.Option key={n} value={n}>{n} 章</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="word_number" label="每章目标字数" initialValue={2000}>
            <Select>
              {[500, 1000, 2000, 3000, 5000].map((n) => (
                <Select.Option key={n} value={n}>{n} 字</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="guidance" label="写作指引">
            <Input.TextArea rows={2} placeholder="对故事风格、内容走向的额外要求（可选）" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
