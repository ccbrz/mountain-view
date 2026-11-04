import { Alert, Button, Collapse, Drawer, Empty, Tag } from 'antd'
import { historyLabels, type Artifact, type ContextView, type HistoryItem, type StoryContext } from './types'

export function HistoryDrawer({
  open,
  chapterIdx,
  items,
  artifact,
  locked,
  canRestoreMemory,
  onOpenItem,
  onRestore,
  onShowContext,
  onClose,
}: {
  open: boolean
  chapterIdx: number
  items: HistoryItem[]
  artifact: Artifact | null
  locked: boolean
  canRestoreMemory: boolean
  onOpenItem: (id: string) => void
  onRestore: () => void
  onShowContext: (title: string, context: StoryContext) => void
  onClose: () => void
}) {
  return (
    <Drawer title={`第 ${chapterIdx} 章 · 生成记录`} open={open} onClose={onClose} width="min(820px, 100vw)">
      <p className="panel-footnote">正文与核对结果自动归档，刷新后仍可查看。恢复草稿后，3 秒自动保存。</p>
      {items.length ? (
        <div className="memory-history">
          <ol className="memory-timeline">
            {items.map(item => (
              <li key={item.id}>
                <button
                  className={artifact?.id === item.id ? 'active' : ''}
                  disabled={locked}
                  onClick={() => onOpenItem(item.id)}
                >
                  <strong>{historyLabels[item.kind]}</strong>
                  <span>{new Date(item.created_at).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="memory-history-preview">
            {artifact ? (
              <section className="history-preview">
                <h3>
                  {historyLabels[artifact.kind]}
                  {artifact.incomplete && (
                    <Tag color="warning" style={{ marginLeft: 8 }}>
                      输出截断 · 未完成
                    </Tag>
                  )}
                </h3>
                <p className="panel-footnote">
                  {artifact.context.model?.name} · {artifact.context.model?.model}
                </p>
                <div className="history-actions">
                  {!['prepare', 'check'].includes(artifact.kind) && (
                    <Button disabled={locked || (artifact.kind === 'memory' && !canRestoreMemory)} onClick={onRestore}>
                      {artifact.kind === 'memory' ? '作为 Memory 建议重新核对' : '恢复为正文草稿'}
                    </Button>
                  )}
                  <Button
                    type="text"
                    disabled={locked}
                    onClick={() => onShowContext('历史请求上下文', artifact.context)}
                  >
                    查看当时上下文
                  </Button>
                </div>
                <pre className="memory-snapshot-preview">
                  {artifact.content ??
                    artifact.replacement ??
                    artifact.memory ??
                    JSON.stringify(artifact.preparation ?? artifact.review, null, 2)}
                </pre>
              </section>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择左侧记录查看" />
            )}
          </div>
        </div>
      ) : (
        <Empty description="本章还没有生成记录" />
      )}
    </Drawer>
  )
}

export function ContextDrawer({
  view,
  locked,
  onPreview,
  onClose,
}: {
  view: ContextView | null
  locked: boolean
  onPreview: (mode: 'write' | 'continue') => void
  onClose: () => void
}) {
  const context = view?.context
  return (
    <Drawer
      title={view?.title || '上下文'}
      open={Boolean(view)}
      onClose={onClose}
      width="min(840px, 100vw)"
      className="context-drawer"
    >
      {view && context && (
        <div className="context-details">
          {view.preview_mode && (
            <section aria-label="上下文预览任务">
              <h3>预览任务</h3>
              <div className="mode-options">
                {(['write', 'continue'] as const).map(mode => (
                  <Button
                    key={mode}
                    aria-pressed={view.preview_mode === mode}
                    disabled={locked}
                    type={view.preview_mode === mode ? 'primary' : 'default'}
                    onClick={() => onPreview(mode)}
                  >
                    {mode === 'write' ? '整章生成' : '继续写'}
                  </Button>
                ))}
              </div>
              <p className="panel-footnote">切换后刷新下方预览；NovelAI 会请求 token 计数，不生成正文。</p>
            </section>
          )}
          <div className="context-summary">
            <Tag bordered={false}>{context.chars.toLocaleString()} 字符</Tag>
            {context.model && (
              <Tag bordered={false}>
                {context.model.name} · {context.model.model}
              </Tag>
            )}
            <span>前章：{context.recent_sources.length ? context.recent_sources.join('、') : '未带入'}</span>
          </div>
          {context.budget && (
            <section aria-label="上下文容量预算">
              <h3>
                上下文预算{' '}
                <Tag color={context.budget.blocked ? 'error' : 'success'}>
                  {context.budget.blocked ? '必要内容超限 · 不会发送' : '预算内'}
                </Tag>
              </h3>
              <div className="budget-bar" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.min(100, (context.budget.estimated_input_tokens / context.budget.context_tokens) * 100)}%`,
                  }}
                />
                <span
                  className="output"
                  style={{
                    width: `${Math.min(100, ((context.budget.output_tokens + context.budget.reserved_tokens) / context.budget.context_tokens) * 100)}%`,
                  }}
                />
              </div>
              <p className="panel-footnote">
                输入 {context.budget.estimated_input_tokens.toLocaleString()} + 输出预留{' '}
                {context.budget.output_tokens.toLocaleString()} + 消息余量 {context.budget.reserved_tokens} / 容量{' '}
                {context.budget.context_tokens.toLocaleString()} tokens。
                {context.budget.method === 'novelai-token-count'
                  ? '输入使用 NovelAI 官方 tokenizer 计数。'
                  : '输入按 UTF-8 字节数保守估算，非模型精确 token 计数。'}
                预算不足时先裁剪较远正文和辅助材料；必要内容放不下时停止调用。
              </p>
            </section>
          )}
          {context.warnings.map((warning, index) => (
            <Alert key={index} type="warning" showIcon message={warning} />
          ))}
          {context.lore_status && (
            <section>
              <h3>设定如何带入</h3>
              <div className="lore-status-list">
                {context.lore_status.map(entry => (
                  <div key={entry.id}>
                    <span>{entry.title || entry.id}</span>
                    <Tag color={entry.included ? 'gold' : undefined} bordered={false}>
                      {entry.included ? '已带入' : '未带入'}
                    </Tag>
                    <small>
                      {entry.reason}
                      {entry.matched_source ? ` · ${entry.matched_source}` : ''}
                      {entry.matched_key ? ` · ${entry.matched_key}` : ''}
                    </small>
                  </div>
                ))}
              </div>
            </section>
          )}
          <Collapse
            items={[
              {
                key: 'system',
                label: '系统提示词（写作要求、文风与篇幅）',
                children: <pre>{context.system_prompt}</pre>,
              },
              ...context.blocks.map((block, index) => ({
                key: `block-${index}`,
                label: `${block.label} · ${Array.from(block.text).length} 字符`,
                children: <pre>{block.text}</pre>,
              })),
              { key: 'full', label: '用户提示词（设定、台本与本次任务）', children: <pre>{context.user_prompt}</pre> },
            ]}
          />
        </div>
      )}
    </Drawer>
  )
}
