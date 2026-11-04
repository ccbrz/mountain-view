import { Alert, Button, Collapse, Tag } from 'antd'
import type { CheckView, PreparationView, StoryContext } from './types'

const BEAT_TONE = { 已写: 'success', 弱化: 'warning', 漏写: 'error' } as const

/** Pre-writing check: verbatim conflicts block generation; facts are derived notes, never a second Memory. */
export function PreparationNote({
  preparation,
  onShowContext,
}: {
  preparation: PreparationView
  onShowContext: (title: string, context: StoryContext) => void
}) {
  const { conflicts, facts } = preparation.preparation
  return (
    <section className="chapter-note" aria-label="写前核对结果">
      {conflicts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="材料的时间点或事实存在冲突"
          description={
            <div>
              {conflicts.map((item, i) => (
                <p key={i} className="issue-line">
                  <span>
                    {item.source}「{item.quote}」
                  </span>
                  <span>台本「{item.plan_quote}」</span>
                  <strong>{item.problem}</strong>
                </p>
              ))}
              <p>请修改对应材料后重新生成。系统没有自动选择版本或更新 Memory。</p>
            </div>
          }
        />
      )}
      <Collapse
        ghost
        items={[
          {
            key: 'preparation',
            label: `写前核对 · 事实与知情边界${facts.length ? `（${facts.length}）` : ''}`,
            children: (
              <>
                <p className="panel-footnote">由本次材料整理，不是另一份记忆；正文生成仍按完整台本执行。</p>
                {facts.map((item, i) => (
                  <p key={i} className="issue-line">
                    <span className="issue-quote">「{item.quote}」</span>
                    <span>{item.note}</span>
                  </p>
                ))}
                <Button size="small" type="link" onClick={() => onShowContext('写前核对实际请求', preparation.context)}>
                  查看核对材料
                </Button>
              </>
            ),
          },
        ]}
      />
    </section>
  )
}

function lengthAdvice(quality: CheckView) {
  const { review, length } = quality
  if (length.status === 'long') return '篇幅偏长，可压缩重复表达。'
  if (length.status !== 'short') return '字数在目标范围内。'
  if (review.raw || !review.beats?.length) return '尚不能确认台本是否写全，可点击「全文精修」检查。'
  if (review.beats.some(b => b.status !== '已写')) return '有事件尚未充分落实，可按台本补写。'
  return '台本已覆盖，篇幅偏短；可展开已有情节，不在章尾添加新剧情凑字。'
}

/** Diagnosis from the latest full refinement. Advisory only; the author decides. */
export function QualityNote({
  quality,
  current,
  onShowContext,
}: {
  quality: CheckView
  current: boolean
  onShowContext: (title: string, context: StoryContext) => void
}) {
  const { review, length } = quality
  return (
    <section className="chapter-note quality-note" aria-label="写后核对结果">
      <div className="section-heading">
        <h3>本轮精修诊断</h3>
        <div className="section-tools">
          {!current && (
            <Tag color="warning" bordered={false}>
              已过期
            </Tag>
          )}
          {!review.raw && (
            <Tag color={review.verdict === 'pass' ? 'success' : 'default'} bordered={false}>
              {review.total} 分
            </Tag>
          )}
        </div>
      </div>
      {review.summary && <p>{review.summary}</p>}
      <p className="panel-footnote">
        正文 {length.chars.toLocaleString()} 字，目标 {length.min}–{length.max} 字。{lengthAdvice(quality)}
        诊断是模型建议，定稿仍需作者判断。
      </p>
      {review.raw ? (
        <Alert
          type="warning"
          message="核对结果未成功解析，可点击「全文精修」重新检查；正文已保留"
          description={<pre className="mv-pre">{review.raw}</pre>}
        />
      ) : (
        <Collapse
          ghost
          items={[
            {
              key: 'issues',
              label: `${review.issues.length} 项意见 · ${review.beats?.length || 0} 个台本事件`,
              children: (
                <>
                  {review.beats?.map(b => (
                    <p key={b.point} className="issue-line">
                      <span>
                        <Tag color={BEAT_TONE[b.status]} bordered={false}>
                          {b.status}
                        </Tag>
                        {b.point}. {b.text}
                      </span>
                      {b.quote && <span className="issue-quote">「{b.quote}」</span>}
                    </p>
                  ))}
                  {review.issues.map((item, i) => (
                    <p key={i} className="issue-line">
                      <span>
                        <Tag bordered={false}>{item.layer || item.dimension}</Tag>
                        <Tag color={item.severity === '必改' ? 'error' : 'default'} bordered={false}>
                          {item.severity}
                        </Tag>
                        {item.resolution === 'author_decision' && <Tag bordered={false}>需作者决定</Tag>}
                        <strong>{item.problem}</strong>
                      </span>
                      {item.quote && <span className="issue-quote">「{item.quote}」</span>}
                      <span>{item.suggestion}</span>
                    </p>
                  ))}
                </>
              ),
            },
          ]}
        />
      )}
      <Button type="link" size="small" onClick={() => onShowContext('写后核对实际请求', quality.context)}>
        查看核对依据
      </Button>
    </section>
  )
}
