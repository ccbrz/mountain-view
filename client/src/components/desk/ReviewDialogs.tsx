import { Alert, Button, Checkbox, Collapse, Input, Modal, Tag } from 'antd'
import { proseLength, type RepairView, type Revision, type StoryContext } from './types'

const lengthNote = (status: string) =>
  status === 'short' ? '篇幅仍偏短，不自动添加新剧情凑字。' : status === 'long' ? '篇幅仍偏长。' : '字数在目标范围内。'

export function RepairModal({
  repair,
  locked,
  current,
  onAccept,
  onClose,
  onShowContext,
}: {
  repair: RepairView | null
  locked: boolean
  /** The candidate still matches the manuscript and settings it was built from. */
  current: boolean
  onAccept: () => void
  onClose: () => void
  onShowContext: (title: string, context: StoryContext) => void
}) {
  return (
    <Modal
      title="全文精修 · 复核后对比采用"
      open={Boolean(repair)}
      onCancel={() => !locked && onClose()}
      width={1040}
      footer={
        <>
          <Button disabled={locked} onClick={onClose}>
            保留原稿
          </Button>
          <Button type="primary" disabled={locked || !repair?.applied.length || !current} onClick={onAccept}>
            采用通过复核的修改
          </Button>
        </>
      }
    >
      {repair && (
        <div className="repair-body">
          <p className="modal-description">
            已完成故事、用笔、表达三层诊断与定点修订；有修改时已做候选复核。只采用下列通过复核的补丁，其余正文保持原样。模型核验仍可能漏判，请对比后采用。
          </p>
          {repair.diagnosis?.summary && <p className="repair-summary">{repair.diagnosis.summary}</p>}
          {repair.length && (
            <div className="repair-stats">
              <Tag bordered={false}>
                正文 {repair.length.before.toLocaleString()} → {repair.length.chars.toLocaleString()} 字
              </Tag>
              <Tag bordered={false}>
                目标 {repair.length.min}–{repair.length.max} 字
              </Tag>
              <span>{lengthNote(repair.length.status)}</span>
            </div>
          )}
          {!current && (
            <Alert type="warning" showIcon message="正文或设定已变化，这份结果不能直接采用，请重新全文精修。" />
          )}
          {repair.audit?.warning && <Alert type="warning" showIcon message={repair.audit.warning} />}
          {!repair.applied.length && <Alert type="info" showIcon message="本轮没有可采用的修改，原稿保留。" />}
          {!!repair.failed.length && (
            <Alert
              type="warning"
              showIcon
              message={`${repair.failed.length} 处建议无法唯一定位，已跳过，未改动对应原文。`}
            />
          )}

          {repair.applied.map((patch, i) => (
            <section key={i} className="revision-preview">
              <h4>
                <span className="patch-index">{i + 1}</span>
                {patch.note}
              </h4>
              <div className="comparison">
                <div>
                  <h5>原文</h5>
                  <pre className="diff-old">{patch.find}</pre>
                </div>
                <div>
                  <h5>替换为</h5>
                  <pre className="diff-new">{patch.replace || '（删除）'}</pre>
                </div>
              </div>
            </section>
          ))}

          <Collapse
            ghost
            items={[
              ...(repair.author_decisions?.length
                ? [
                    {
                      key: 'decisions',
                      label: `需作者决定或核对依据 · ${repair.author_decisions.length} 项`,
                      children: repair.author_decisions.map((issue, n) => (
                        <p key={n} className="issue-line">
                          <strong>
                            {issue.layer || issue.dimension} · {issue.problem}
                          </strong>
                          {issue.quote && <span className="issue-quote">「{issue.quote}」</span>}
                          <span>{issue.suggestion}</span>
                        </p>
                      )),
                    },
                  ]
                : []),
              ...(repair.blocked?.length
                ? [
                    {
                      key: 'blocked',
                      label: `未放行的修改 · ${repair.blocked.length} 项`,
                      children: repair.blocked.map((item, n) => (
                        <section key={n} className="issue-line">
                          <strong>{item.patch.note}</strong>
                          <span>{item.reason}</span>
                          <pre className="mv-pre">{item.patch.replace || '（删除）'}</pre>
                        </section>
                      )),
                    },
                  ]
                : []),
            ]}
          />
          {repair.contexts && (
            <div className="context-links">
              {(['diagnosis', 'revision', 'audit'] as const).map(
                (key, i) =>
                  repair.contexts?.[key] && (
                    <Button
                      key={key}
                      type="link"
                      size="small"
                      onClick={() =>
                        onShowContext(['精修诊断请求', '定点修订请求', '候选复核请求'][i], repair.contexts![key]!)
                      }
                    >
                      {['诊断依据', '改稿请求', '复核依据'][i]}
                    </Button>
                  ),
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

export function RevisionModal({
  revision,
  warnings,
  acknowledged,
  locked,
  onAcknowledge,
  onChange,
  onAccept,
  onCancel,
}: {
  revision: Revision | null
  warnings: string[]
  acknowledged: boolean
  locked: boolean
  onAcknowledge: (value: boolean) => void
  onChange: (replacement: string) => void
  onAccept: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      title="修改建议"
      open={Boolean(revision)}
      width={960}
      onCancel={onCancel}
      onOk={onAccept}
      okText="接受并替换选段"
      cancelText="放弃建议"
      okButtonProps={{ disabled: locked || !revision?.replacement.trim() || (warnings.length > 0 && !acknowledged) }}
    >
      {revision && (
        <>
          <p className="modal-description">
            右侧全部文字会替换左侧选区，可直接编辑；接受后 3 秒自动保存。本次要求：{revision.instruction}
          </p>
          {warnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="修改建议可能超出要求，请先核对"
              description={
                <ul className="plain-list">
                  {warnings.map(issue => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              }
            />
          )}
          <div className="comparison">
            <div>
              <h4>原选区 · {proseLength(revision.selected)} 字</h4>
              <pre>{revision.selected}</pre>
            </div>
            <div>
              <h4>替换文字 · {proseLength(revision.replacement)} 字</h4>
              <Input.TextArea
                aria-label="修改后的选段"
                autoSize={{ minRows: 8, maxRows: 18 }}
                maxLength={100000}
                value={revision.replacement}
                onChange={e => onChange(e.target.value)}
              />
            </div>
          </div>
          <section className="revision-preview" aria-label="替换后的衔接预览">
            <h4>替换后的衔接预览</h4>
            <p className="modal-description">灰色为保留的前后文，金色为替换文字。前后各展示最多 200 字符。</p>
            <div className="revision-joined">
              <span className="revision-neighbor">
                {Array.from(revision.before).length > 200 ? '…' : ''}
                {Array.from(revision.before).slice(-200).join('')}
              </span>
              <mark>{revision.replacement}</mark>
              <span className="revision-neighbor">
                {Array.from(revision.after).slice(0, 200).join('')}
                {Array.from(revision.after).length > 200 ? '…' : ''}
              </span>
            </div>
          </section>
          {warnings.length > 0 && (
            <Checkbox checked={acknowledged} onChange={e => onAcknowledge(e.target.checked)}>
              我已核对上述提示和衔接，仍要替换
            </Checkbox>
          )}
        </>
      )}
    </Modal>
  )
}
