import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Collapse, Empty, Input, Modal, Select, Space, Spin, Tag, Typography } from 'antd'
import api from '../api'

type Config = { name: string; model_name: string }
type Turn = {
  role: 'user' | 'assistant'
  content: string
  finish_reason?: string
  refusal?: string
  duration_ms?: number
}

const finishLabel = (reason: string) =>
  reason === 'content_filter' ? '内容过滤' : reason === 'length' ? '输出截断' : reason

/** Talks to the writing desk's models directly: no novel context, no manuscript or Memory writes, no retries. */
export default function ChatTest({ novelId }: { novelId: string }) {
  const [configs, setConfigs] = useState<Config[]>([])
  const [model, setModel] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [system, setSystem] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  const url = `/novels/${novelId}/chat-test`

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get(url)
      setConfigs(data.configs)
      setModel(current => current || data.configs[0]?.name || '')
    } catch (e: any) {
      setError(e.response?.data?.message || e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [novelId])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [turns, sending])

  const reset = () => {
    setTurns([])
    setError('')
    setPending('')
  }
  const changeModel = (name: string) => {
    const apply = () => {
      setModel(name)
      reset()
    }
    if (turns.length)
      Modal.confirm({
        title: '切换模型并新建对话？',
        content: '当前测试消息会清空。',
        okText: '切换模型',
        cancelText: '继续当前对话',
        onOk: apply,
      })
    else apply()
  }

  const send = async () => {
    if (inFlight.current || !model || !input.trim()) return
    inFlight.current = true
    setSending(true)
    setError('')
    const text = input.trim()
    const messages = [
      ...turns.map(t => ({ role: t.role, content: t.content })),
      { role: 'user' as const, content: text },
    ]
    setPending(text)
    try {
      const { data } = await api.post(url, { config_name: model, messages, system_prompt: system })
      const content = data.content || data.refusal
      if (!content) {
        setError(
          `模型未返回正文（结束原因：${data.finish_reason}）。${data.finish_reason === 'content_filter' ? '服务返回了内容过滤标记。' : ''} 输入已保留，未自动重试。`,
        )
        return
      }
      setTurns([
        ...messages,
        {
          role: 'assistant',
          content,
          finish_reason: data.finish_reason,
          refusal: data.refusal,
          duration_ms: data.duration_ms,
        },
      ])
      setInput('')
    } catch (e: any) {
      setError(`${e.response?.data?.message || e.message}。输入已保留，未自动重试。`)
    } finally {
      inFlight.current = false
      setSending(false)
      setPending('')
    }
  }

  const validModel = configs.some(c => c.name === model)
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        独立测试对话，不带入小说上下文，也不修改正文或记忆。消息仅在当前页面保留。
      </Typography.Text>
      <div>
        <label htmlFor="chat-test-model" className="tool-label">
          写作台模型
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <Select
            id="chat-test-model"
            aria-label="写作台模型"
            style={{ flex: 1, minWidth: 0 }}
            loading={loading}
            disabled={sending}
            value={validModel ? model : undefined}
            placeholder="选择要测试的模型"
            onChange={changeModel}
            options={configs.map(c => ({ value: c.name, label: `${c.name} · ${c.model_name}` }))}
          />
          <Button disabled={sending} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </div>
        {!loading && !configs.length && (
          <Alert
            style={{ marginTop: 8 }}
            type="info"
            showIcon
            message="请先在写作台「参数」中选择创作模型（或在 Lorebook 中选择设定生成模型）并保存。"
          />
        )}
      </div>
      <Collapse
        items={[
          {
            key: 'system',
            label: '系统提示（可选）',
            children: (
              <>
                <Input.TextArea
                  aria-label="测试系统提示"
                  value={system}
                  maxLength={2000}
                  showCount
                  rows={3}
                  disabled={sending || turns.length > 0}
                  onChange={e => setSystem(e.target.value)}
                  placeholder="留空时直接发送你的消息，不使用小说写作提示词"
                />
                {!!turns.length && <Typography.Text type="secondary">新建对话后可修改系统提示。</Typography.Text>}
              </>
            ),
          },
        ]}
      />
      <div role="log" aria-label="测试对话记录" aria-live="polite" className="chat-log">
        {!turns.length && !sending && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="发送一条消息，开始测试" />
        )}
        {turns.map((t, i) => (
          <div key={i} className={`chat-turn ${t.role}`}>
            <Space wrap size={6}>
              <Typography.Text strong>{t.role === 'user' ? '你' : '模型'}</Typography.Text>
              {t.duration_ms !== undefined && (
                <Typography.Text type="secondary">{(t.duration_ms / 1000).toFixed(1)} 秒</Typography.Text>
              )}
              {t.finish_reason && (
                <Tag
                  color={
                    t.finish_reason === 'content_filter'
                      ? 'error'
                      : t.finish_reason === 'length'
                        ? 'warning'
                        : 'default'
                  }
                >
                  {finishLabel(t.finish_reason)}
                </Tag>
              )}
              {t.refusal && <Tag color="error">拒绝响应</Tag>}
            </Space>
            <div className="chat-turn-text">{t.content}</div>
            {!!t.refusal && t.refusal !== t.content && (
              <Alert type="warning" message={t.refusal} style={{ marginTop: 8 }} />
            )}
          </div>
        ))}
        {sending && (
          <div className="chat-turn user">
            <Typography.Text strong>你</Typography.Text>
            <div className="chat-turn-text">{pending}</div>
            <Space>
              <Spin size="small" />
              <Typography.Text type="secondary">等待模型回复…</Typography.Text>
            </Space>
          </div>
        )}
        <div ref={end} />
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      <Input.TextArea
        aria-label="测试消息"
        placeholder="输入消息；Ctrl / ⌘ + Enter 发送"
        value={input}
        onChange={e => setInput(e.target.value)}
        disabled={sending}
        autoSize={{ minRows: 3, maxRows: 8 }}
        maxLength={8000}
        showCount
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <Space wrap>
        <Button
          type="primary"
          loading={sending}
          disabled={loading || !validModel || !input.trim()}
          onClick={() => void send()}
        >
          发送
        </Button>
        <Button
          disabled={sending || !turns.length}
          onClick={() =>
            Modal.confirm({
              title: '清空当前测试记录，开始新对话？',
              okText: '新建对话',
              cancelText: '保留当前对话',
              onOk: reset,
            })
          }
        >
          新建对话
        </Button>
        <Typography.Text type="secondary">连续发送会携带本会话历史。失败不自动重试。</Typography.Text>
      </Space>
    </Space>
  )
}
