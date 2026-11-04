import { useEffect, useState } from 'react'
import { AutoComplete, Button, Dropdown, Empty, Form, Input, InputNumber, Modal, Skeleton, Tag, message } from 'antd'
import { DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import api from '../api'
import './Bookshelf.css'

interface Novel {
  id: number
  title: string
  creator_username: string
  genre: string
  word_number: number
  guidance: string
  chapter_count: number
  word_count: number
  finalized_count: number
  updated_at: string
}

const GENRES = ['科幻', '奇幻', '玄幻', '悬疑', '都市', '言情', '历史', '武侠', '恐怖'].map(value => ({ value }))

function relativeTime(value: string) {
  // SQLite CURRENT_TIMESTAMP is UTC without a zone suffix.
  const time = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z').getTime()
  const minutes = Math.round((Date.now() - time) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时前`
  if (minutes < 60 * 24 * 30) return `${Math.round(minutes / 60 / 24)} 天前`
  return new Date(time).toLocaleDateString('zh-CN')
}

export default function Bookshelf() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [novels, setNovels] = useState<Novel[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Novel | 'new' | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()
  const isAdmin = user?.role === 'admin'

  const fetchNovels = async () => {
    try {
      const res = await api.get('/novels', { params: search ? { search } : {} })
      setNovels(res.data)
    } catch {
      message.error('获取作品列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = setTimeout(fetchNovels, search ? 300 : 0)
    return () => clearTimeout(timer)
  }, [search])

  const openEditor = (novel: Novel | 'new') => {
    form.resetFields()
    form.setFieldsValue(novel === 'new' ? { word_number: 3000 } : novel)
    setEditing(novel)
  }

  const handleSave = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editing === 'new') {
        const res = await api.post('/novels', values)
        message.success('作品已创建，开始写第一章吧')
        navigate(`/novels/${res.data.id}`)
        return
      }
      await api.put(`/novels/${(editing as Novel).id}`, values)
      message.success('作品信息已更新')
      setEditing(null)
      fetchNovels()
    } catch (error: any) {
      message.error(error.response?.data?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = (novel: Novel) =>
    Modal.confirm({
      title: `删除《${novel.title}》？`,
      content: '全部章节、Memory、设定与生成记录都会被删除，且无法恢复。建议先在写作台导出 JSON 备份。',
      okText: '删除作品',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        await api.delete(`/novels/${novel.id}`)
        message.success('作品已删除')
        fetchNovels()
      },
    })

  return (
    <div className="mv-page">
      <header className="mv-page-header">
        <div>
          <span className="mv-eyebrow">Library</span>
          <h1>书架</h1>
          <p>{loading ? '正在整理书架…' : novels.length ? `共 ${novels.length} 部作品` : '从一部新作品开始'}</p>
        </div>
        <div className="mv-page-actions">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索作品标题"
            aria-label="搜索作品"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 240 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor('new')}>
            新建作品
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="book-grid">
          {[0, 1, 2].map(i => (
            <div key={i} className="book-card">
              <Skeleton active paragraph={{ rows: 3 }} />
            </div>
          ))}
        </div>
      ) : novels.length === 0 ? (
        <div className="book-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={search ? '没有找到匹配的作品' : '书架还是空的。新建作品后，直接进入写作台写第一章。'}
          >
            {!search && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor('new')}>
                新建作品
              </Button>
            )}
          </Empty>
        </div>
      ) : (
        <div className="book-grid">
          {novels.map(novel => (
            <article
              key={novel.id}
              className="book-card"
              tabIndex={0}
              role="link"
              aria-label={`打开《${novel.title}》`}
              onClick={() => navigate(`/novels/${novel.id}`)}
              onKeyDown={e => {
                if (e.key === 'Enter') navigate(`/novels/${novel.id}`)
              }}
            >
              <span className="book-spine" aria-hidden="true" />
              <div className="book-card-top">
                {novel.genre ? <Tag bordered={false}>{novel.genre}</Tag> : <span />}
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      { key: 'edit', icon: <EditOutlined />, label: '作品信息' },
                      { type: 'divider' },
                      { key: 'delete', icon: <DeleteOutlined />, label: '删除作品', danger: true },
                    ],
                    onClick: ({ key, domEvent }) => {
                      domEvent.stopPropagation()
                      if (key === 'edit') openEditor(novel)
                      else handleDelete(novel)
                    },
                  }}
                >
                  <Button
                    type="text"
                    size="small"
                    className="book-menu"
                    aria-label={`《${novel.title}》操作`}
                    icon={<MoreOutlined />}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => e.stopPropagation()}
                  />
                </Dropdown>
              </div>
              <h2 className="book-title">{novel.title}</h2>
              <p className="book-guidance">{novel.guidance || `每章目标 ${novel.word_number.toLocaleString()} 字`}</p>
              <dl className="book-stats">
                <div>
                  <dt>章节</dt>
                  <dd>{novel.chapter_count}</dd>
                </div>
                <div>
                  <dt>字数</dt>
                  <dd>
                    {novel.word_count >= 10000
                      ? `${(novel.word_count / 10000).toFixed(1)} 万`
                      : novel.word_count.toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>已定稿</dt>
                  <dd>{novel.finalized_count}</dd>
                </div>
              </dl>
              <footer className="book-footer">
                <span>更新于 {relativeTime(novel.updated_at)}</span>
                {isAdmin && novel.creator_username !== user?.username && <span>{novel.creator_username}</span>}
              </footer>
            </article>
          ))}
        </div>
      )}

      <Modal
        title={editing === 'new' ? '新建作品' : '作品信息'}
        open={Boolean(editing)}
        onOk={handleSave}
        onCancel={() => setEditing(null)}
        okText={editing === 'new' ? '创建并开始写作' : '保存'}
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 16 }}>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, whitespace: true, message: '请输入作品标题' }]}
          >
            <Input placeholder="作品标题" maxLength={200} autoFocus />
          </Form.Item>
          <Form.Item name="genre" label="类型">
            <AutoComplete options={GENRES} placeholder="科幻 / 悬疑 / 言情…" filterOption />
          </Form.Item>
          <Form.Item
            name="word_number"
            label="每章目标字数"
            extra="生成时按目标字数到其 1.25 倍控制篇幅，含标点、不含空白。"
            rules={[{ required: true, message: '请填写每章目标字数' }]}
          >
            <InputNumber min={100} max={50000} step={500} addonAfter="字" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="guidance" label="写作指引" extra="对全书风格、内容走向的长期要求，会带入每次生成。">
            <Input.TextArea rows={3} maxLength={20000} placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
