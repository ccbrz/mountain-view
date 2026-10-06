import { useState } from 'react'
import { Button, Checkbox, Space, Tag, Alert, Empty, message, Divider, Collapse, Progress, Input, Popconfirm } from 'antd'
import { AuditOutlined, EditOutlined, HistoryOutlined } from '@ant-design/icons'
import api from '../api'

export interface ReviewIssue {
  dimension: string
  severity: '必改' | '可改'
  problem: string
  quote: string
  suggestion: string
}

interface ReviewScores {
  coverage: number
  prose: number
  consistency: number
  webnovel: number
}

export interface ReviewBeat {
  point: number
  text: string
  status: '已写' | '弱化' | '漏写'
  quote: string
}

/** AI 味检测脚本的命中，按类型汇总；文笔分由它算出 */
export interface AiCheck {
  type: string
  label: string
  severity: 'blocking' | 'advisory'
  count: number
}

export interface ReviewResult {
  summary: string
  verdict: 'pass' | 'revise'
  scores: ReviewScores
  total: number
  beats?: ReviewBeat[]
  aiChecks?: AiCheck[]
  issues: ReviewIssue[]
  raw?: string
}

const BEAT_COLOR: Record<ReviewBeat['status'], string> = { 已写: 'green', 弱化: 'orange', 漏写: 'red' }

interface Patch {
  note: string
  find: string
  replace: string
}

interface ReviseResponse {
  message: string
  applied: Patch[]
  failed: { patch: Patch; reason: string }[]
  word_delta: number
  word_count: number
}

/** 与服务端 review.ts 的 SCORE_MAX 保持一致 */
const SCORE_ROWS: { key: keyof ReviewScores; label: string; max: number }[] = [
  { key: 'coverage', label: '台本覆盖', max: 40 },
  { key: 'prose', label: 'AI 味', max: 25 },
  { key: 'consistency', label: '设定一致', max: 15 },
  { key: 'webnovel', label: '网文指标', max: 20 },
]

const scoreColor = (ratio: number) => (ratio >= 0.8 ? '#52c41a' : ratio >= 0.6 ? '#faad14' : '#ff4d4f')

/** 勾选项：note 就是发给后端的文本 */
interface Item {
  key: string
  issue: ReviewIssue
  note: string
}

function buildItems(review: ReviewResult): Item[] {
  return review.issues.map((it, i) => ({
    key: `i${i}`,
    issue: it,
    note: `【${it.severity}·${it.dimension}】${it.problem}\n   改法：${it.suggestion}`,
  }))
}

/** 台本类问题用醒目底色，其余统一浅灰 */
const DIMENSION_STYLE: Record<string, { color: string; bg: string; border: string }> = {
  台本漏写: { color: 'red', bg: '#fff2f0', border: '#ffccc7' },
  凭空加戏: { color: 'orange', bg: '#fff7e6', border: '#ffd591' },
}
const DEFAULT_STYLE = { color: 'blue', bg: '#fafafa', border: '#f0f0f0' }

export default function ReviewPanel({
  novelId,
  chapterNum,
  canReview,
  onRevised,
  beforeAction,
}: {
  novelId: string
  chapterNum: number
  canReview: boolean
  onRevised: () => void
  beforeAction: () => Promise<void>
}) {
  const [review, setReview] = useState<ReviewResult | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [reviewing, setReviewing] = useState(false)
  const [revising, setRevising] = useState(false)
  const [revised, setRevised] = useState<ReviseResponse | null>(null)
  const [feedback, setFeedback] = useState('')
  const [regenerating, setRegenerating] = useState(false)

  const runReview = async () => {
    setReviewing(true)
    setRevised(null)
    try {
      await beforeAction()
      const res = await api.post(`/novels/${novelId}/review/${chapterNum}`)
      const r: ReviewResult = res.data.review
      const list = buildItems(r)
      setReview(r)
      setItems(list)
      setChecked(list.filter((i) => i.issue.severity === '必改').map((i) => i.key)) // 默认只勾必改，可改的由作者自己挑
    } catch (err: any) {
      message.error('审稿失败：' + (err.response?.data?.message || err.message))
    } finally {
      setReviewing(false)
    }
  }

  const runRevise = async () => {
    const accepted = items.filter((i) => checked.includes(i.key)).map((i) => i.note)
    const rejected = items.filter((i) => !checked.includes(i.key)).map((i) => i.note)
    if (accepted.length === 0) return message.warning('请至少勾选一条意见')

    setRevising(true)
    try {
      await beforeAction()
      const res = await api.post(`/novels/${novelId}/revise/${chapterNum}`, {
        accepted_notes: accepted,
        rejected_notes: rejected,
      })
      setRevised(res.data)
      message.success(res.data.message)
      onRevised()
    } catch (err: any) {
      message.error('修订失败：' + (err.response?.data?.message || err.message))
    } finally {
      setRevising(false)
    }
  }

  /** 作者自己的意见：整章重新生成（旧稿存进修订记录），和上面按审稿意见打补丁是两条路 */
  const runRegenerate = async () => {
    setRegenerating(true)
    try {
      await beforeAction()
      const res = await api.post(`/novels/${novelId}/generate/chapter/${chapterNum}`, { feedback: feedback.trim() })
      message.success(`已按意见重新生成，${res.data.word_count} 字`)
      setFeedback('')
      setReview(null) // 旧审稿结果对不上新稿了
      setItems([])
      setRevised(null)
      onRevised()
    } catch (err: any) {
      message.error('重新生成失败：' + (err.response?.data?.message || err.message))
    } finally {
      setRegenerating(false)
    }
  }

  const feedbackBox = (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>
        有明显不妥、需要推倒重写的地方？写下你的意见，整章按意见重新生成（当前稿会存进修订记录，可回退）。
      </div>
      <Input.TextArea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="例如：苏晴出场太早，应该等海盗逼近船体后再出手；老赵软化得太快，要有一个挣扎的过程"
        autoSize={{ minRows: 3, maxRows: 8 }}
        disabled={regenerating}
      />
      <Popconfirm
        title="整章重新生成"
        description="当前正文会被替换（已存进修订记录），确定吗？"
        onConfirm={runRegenerate}
        disabled={!feedback.trim()}
      >
        <Button
          danger
          loading={regenerating}
          disabled={!feedback.trim() || revising}
          style={{ marginTop: 8 }}
          block
        >
          {regenerating ? '重新生成中，约需 1–3 分钟…' : '按意见重新生成'}
        </Button>
      </Popconfirm>
    </div>
  )

  if (!review) {
    return (
      <div style={{ marginTop: 16 }}>
        <Divider style={{ margin: '12px 0' }} />
        <Button
          icon={<AuditOutlined />}
          loading={reviewing}
          onClick={runReview}
          disabled={!canReview}
          block
        >
          {reviewing ? '审稿中，约需 30–60 秒…' : '送审'}
        </Button>
        {!canReview && (
          <div style={{ fontSize: 12, color: '#999', marginTop: 6, textAlign: 'center' }}>
            请先在设置中选择审校模型
          </div>
        )}
        {feedbackBox}
      </div>
    )
  }

  const checkedCount = checked.length

  return (
    <div style={{ marginTop: 16 }}>
      <Divider style={{ margin: '12px 0' }} />

      <Alert
        type={review.verdict === 'pass' ? 'success' : 'warning'}
        message={
          <Space>
            <Tag color={review.verdict === 'pass' ? 'green' : 'orange'}>
              {review.verdict === 'pass' ? '可定稿' : '建议修改'}
            </Tag>
            <span style={{ fontWeight: 400 }}>{review.summary}</span>
          </Space>
        }
        style={{ marginBottom: 12 }}
      />

      {!review.raw && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
          <Progress
            type="circle"
            size={64}
            percent={review.total}
            strokeColor={scoreColor(review.total / 100)}
            format={() => <span style={{ fontSize: 18, fontWeight: 600 }}>{review.total}</span>}
          />
          <div style={{ flex: 1 }}>
            {SCORE_ROWS.map((r) => (
              <div key={r.key} style={{ display: 'flex', alignItems: 'center', fontSize: 12 }}>
                <span style={{ width: 56, color: '#666' }}>{r.label}</span>
                <Progress
                  percent={(review.scores[r.key] / r.max) * 100}
                  strokeColor={scoreColor(review.scores[r.key] / r.max)}
                  showInfo={false}
                  size="small"
                  style={{ flex: 1, margin: 0 }}
                />
                <span style={{ width: 44, textAlign: 'right', color: '#666' }}>
                  {review.scores[r.key]}/{r.max}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!review.raw && review.beats && review.beats.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12, lineHeight: 1.7 }}>
          {review.beats.map((b) => (
            <div key={b.point} style={{ display: 'flex', gap: 6 }}>
              <Tag color={BEAT_COLOR[b.status]} style={{ margin: 0, flexShrink: 0 }}>{b.status}</Tag>
              <span style={{ color: '#333' }}>
                {b.point}. {b.text}
                {b.quote && <span style={{ color: '#999' }}>　「{b.quote}」</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {!review.raw && review.aiChecks && review.aiChecks.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12 }}>
          <span style={{ color: '#666', marginRight: 6 }}>AI 味检测</span>
          {review.aiChecks.map((c) => (
            <Tag key={c.type} color={c.severity === 'blocking' ? 'red' : 'gold'} style={{ marginBottom: 4 }}>
              {c.label}×{c.count}
            </Tag>
          ))}
        </div>
      )}

      {review.raw && (
        <Alert
          type="error"
          message="审稿结果解析失败，以下为模型原始输出"
          description={<pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{review.raw}</pre>}
          style={{ marginBottom: 12 }}
        />
      )}

      {items.length === 0 && !review.raw && (
        <Empty description="审稿员没有提出修改意见" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}

      {/* 没有意见可勾选时（解析失败 / 无意见），下面的操作区不渲染，重新审稿入口单独给 */}
      {items.length === 0 && (
        <Button onClick={runReview} loading={reviewing} block>重新审稿</Button>
      )}

      {items.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: '#666' }}>
              共 {items.length} 条，已选 {checkedCount} 条（默认勾选必改）。未勾选的会明确告知模型不要改动。
            </span>
            <Space size={4}>
              <Button size="small" type="link" onClick={() => setChecked(items.map((i) => i.key))}>全选</Button>
              <Button size="small" type="link" onClick={() => setChecked([])}>全不选</Button>
            </Space>
          </div>

          <Checkbox.Group
            value={checked}
            onChange={(v) => setChecked(v as string[])}
            style={{ display: 'block' }}
          >
            {items.map((item) => {
              const it = item.issue
              const s = DIMENSION_STYLE[it.dimension] || DEFAULT_STYLE
              return (
                <div
                  key={item.key}
                  style={{
                    padding: 10,
                    marginBottom: 8,
                    background: s.bg,
                    border: `1px solid ${s.border}`,
                    borderRadius: 4,
                  }}
                >
                  <Checkbox value={item.key} style={{ alignItems: 'flex-start' }}>
                    <div style={{ marginLeft: 4 }}>
                      <div style={{ marginBottom: 4 }}>
                        <Tag color={it.severity === '必改' ? 'red' : 'default'}>{it.severity}</Tag>
                        <Tag color={s.color}>{it.dimension}</Tag>
                      </div>
                      <div style={{ fontSize: 13, lineHeight: 1.6 }}>{it.problem}</div>
                      {it.quote && (
                        <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                          原文：{it.quote}
                        </div>
                      )}
                      {it.suggestion && (
                        <div style={{ fontSize: 12, color: '#555', marginTop: 4, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                          改法：{it.suggestion}
                        </div>
                      )}
                    </div>
                  </Checkbox>
                </div>
              )
            })}
          </Checkbox.Group>

          <Space style={{ marginTop: 8 }}>
            <Button
              type="primary"
              icon={<EditOutlined />}
              loading={revising}
              onClick={runRevise}
              disabled={checkedCount === 0 || regenerating}
            >
              {revising ? '修订中，约需 1–2 分钟…' : `按选中的 ${checkedCount} 条重写`}
            </Button>
            <Button onClick={runReview} loading={reviewing}>重新审稿</Button>
          </Space>
        </>
      )}

      {revised && (
        <div style={{ marginTop: 12 }}>
          <Alert
            type={revised.failed.length > 0 ? 'warning' : 'success'}
            message={
              <span>
                {revised.applied.length} 条补丁生效
                {revised.failed.length > 0 && `，${revised.failed.length} 条未生效`}
                ，字数 {revised.word_count}（
                {revised.word_delta > 0 ? '+' : ''}{revised.word_delta}）
              </span>
            }
          />
          <Collapse
            ghost
            size="small"
            style={{ marginTop: 4 }}
            items={[
              {
                key: 'patches',
                label: <span style={{ fontSize: 12 }}><HistoryOutlined /> 查看改动明细</span>,
                children: (
                  <div style={{ fontSize: 12 }}>
                    {revised.applied.map((p, i) => (
                      <div key={i} style={{ marginBottom: 10 }}>
                        <div style={{ color: '#666', marginBottom: 2 }}>{i + 1}. {p.note}</div>
                        <div style={{ background: '#fff1f0', padding: '2px 6px', borderRadius: 2, marginBottom: 2 }}>
                          − {p.find.slice(0, 120)}{p.find.length > 120 ? `…（${p.find.length} 字）` : ''}
                        </div>
                        <div style={{ background: '#f6ffed', padding: '2px 6px', borderRadius: 2 }}>
                          + {p.replace ? p.replace.slice(0, 120) + (p.replace.length > 120 ? `…（${p.replace.length} 字）` : '') : '（整段删除）'}
                        </div>
                      </div>
                    ))}
                    {revised.failed.map((f, i) => (
                      <div key={`f${i}`} style={{ marginBottom: 6, color: '#cf1322' }}>
                        未生效［{f.reason}］{f.patch.note}
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      {feedbackBox}
    </div>
  )
}
