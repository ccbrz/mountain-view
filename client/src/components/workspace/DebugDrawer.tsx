import { useEffect, useState } from 'react'
import { Badge, Button, Collapse, Drawer, Empty, Popconfirm, Space, Spin, Tabs, Tag, Typography, message } from 'antd'
import { BugOutlined, ClearOutlined, ReloadOutlined } from '@ant-design/icons'
import api from '../../api'
import ChatTest from '../ChatTest'

interface LLMCallLog {
  id: string
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

const STATUS = {
  pending: { color: 'processing', label: '调用中' },
  success: { color: 'success', label: '成功' },
  error: { color: 'error', label: '失败' },
} as const

function LogBlock({ label, text, tone }: { label: string; text: string; tone?: 'error' | 'success' }) {
  return (
    <div className="log-block">
      <div className="log-block-label">{label}</div>
      <pre className={`log-block-text ${tone || ''}`}>{text || '（空）'}</pre>
    </div>
  )
}

/** Model chat test and raw call logs. Logs poll every 3 seconds while their tab is open. */
export default function DebugDrawer({
  novelId,
  open,
  onClose,
}: {
  novelId: string
  open: boolean
  onClose: () => void
}) {
  const [tab, setTab] = useState('chat')
  const [logs, setLogs] = useState<LLMCallLog[]>([])
  const [loading, setLoading] = useState(false)

  const fetchLogs = async () => {
    setLoading(true)
    try {
      setLogs((await api.get(`/novels/${novelId}/llm-logs?limit=100`)).data)
    } catch {
      // Keep the last successful list; the next poll retries.
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open || tab !== 'logs') return
    void fetchLogs()
    const timer = setInterval(fetchLogs, 3000)
    return () => clearInterval(timer)
  }, [open, tab, novelId])

  const clearLogs = async () => {
    try {
      await api.delete(`/novels/${novelId}/llm-logs`)
      setLogs([])
      message.success('日志已清空')
    } catch {
      message.error('清空日志失败')
    }
  }

  return (
    <Drawer
      title={
        <Space>
          <BugOutlined />
          模型调试
        </Space>
      }
      width="min(760px, 100vw)"
      open={open}
      onClose={onClose}
      extra={
        tab === 'logs' && (
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchLogs} loading={loading}>
              刷新
            </Button>
            <Popconfirm title="清空本书所有调用日志？" okText="清空" cancelText="取消" onConfirm={clearLogs}>
              <Button icon={<ClearOutlined />} danger>
                清空
              </Button>
            </Popconfirm>
          </Space>
        )
      }
    >
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'chat', label: '对话测试', children: <ChatTest key={novelId} novelId={novelId} /> },
          {
            key: 'logs',
            label: (
              <Space>
                调用日志
                <Badge count={logs.length} overflowCount={99} color="#3a3d45" />
              </Space>
            ),
            children:
              loading && !logs.length ? (
                <div className="log-empty">
                  <Spin />
                </div>
              ) : !logs.length ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无调用日志" />
              ) : (
                <Collapse
                  accordion
                  items={logs.map(log => ({
                    key: log.id,
                    label: (
                      <Space wrap>
                        <Tag color={STATUS[log.status]?.color || 'processing'}>
                          {STATUS[log.status]?.label || log.status}
                        </Tag>
                        <Tag bordered={false}>{log.task}</Tag>
                        <Typography.Text type="secondary">{log.model_name}</Typography.Text>
                        <Typography.Text type="secondary">
                          {log.status === 'pending' ? '…' : `${(log.duration_ms / 1000).toFixed(1)} 秒`} ·{' '}
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </Typography.Text>
                      </Space>
                    ),
                    children: (
                      <>
                        <LogBlock label="System Prompt" text={log.system_prompt} />
                        <LogBlock label="User Prompt" text={log.user_prompt} />
                        {log.status === 'pending' ? (
                          <div className="log-empty">
                            <Spin size="small" /> 等待模型响应…
                          </div>
                        ) : log.error ? (
                          <LogBlock label="Error" text={log.error} tone="error" />
                        ) : (
                          <LogBlock label="Response" text={log.response} tone="success" />
                        )}
                      </>
                    ),
                  }))}
                />
              ),
          },
        ]}
      />
    </Drawer>
  )
}
