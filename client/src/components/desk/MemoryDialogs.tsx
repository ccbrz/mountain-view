import { Alert, Button, Drawer, Empty, Input, Modal, Select, Tag } from 'antd'
import { memoryVersionLabels, type MemoryDraft, type MemoryRestore, type MemoryVersion } from './types'

const throughLabel = (through?: number | null) =>
  through == null ? '进度未知' : through === 0 ? '开篇前' : `至第 ${through} 章`

export function MemoryDraftModal({
  draft,
  locked,
  onChange,
  onConfirm,
  onCancel,
}: {
  draft: MemoryDraft | null
  locked: boolean
  onChange: (proposed: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      title={draft?.finalize ? `第 ${draft.chapter_idx} 章 · 整理 Memory 并定稿` : '更新 Memory'}
      open={Boolean(draft)}
      width={960}
      closable={!locked}
      maskClosable={!locked}
      onCancel={() => !locked && onCancel()}
      okText={draft?.finalize ? '更新 Memory 并定稿' : '确认并保存 Memory'}
      cancelText={draft?.finalize ? '取消定稿' : '保留原记忆'}
      confirmLoading={locked}
      cancelButtonProps={{ disabled: locked }}
      onOk={onConfirm}
    >
      {draft && (
        <>
          <p className="modal-description">
            {draft.finalize
              ? '已根据当前 Memory 与本章已保存正文自动整理。核对并编辑建议后确认，会同时更新全书 Memory、完成本章定稿并保存历史；取消不会改动记忆或定稿状态。'
              : '请核对已发生的事实与人物知情范围。确认会保存右侧建议及当前全书设定，不会自动改写人物条目。'}
          </p>
          {!draft.proposed.trim() && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="建议 Memory 为空，确认后将以空记忆保存，请核对。"
            />
          )}
          <div className="comparison">
            <div>
              <h4>原记忆</h4>
              <pre>{draft.original || '尚无记忆'}</pre>
            </div>
            <div>
              <h4>建议记忆 · 可编辑</h4>
              <Input.TextArea
                aria-label="建议记忆"
                autoSize={{ minRows: 14, maxRows: 22 }}
                maxLength={100000}
                disabled={locked}
                value={draft.proposed}
                onChange={e => onChange(e.target.value)}
              />
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}

export function MemoryHistoryDrawer({
  open,
  versions,
  version,
  locked,
  onSelect,
  onPreviewRestore,
  onClose,
}: {
  open: boolean
  versions: MemoryVersion[]
  version: MemoryVersion | null
  locked: boolean
  onSelect: (id: number) => void
  onPreviewRestore: (id: number) => void
  onClose: () => void
}) {
  return (
    <Drawer title="记忆历史" open={open} onClose={onClose} width="min(820px, 100vw)">
      <p className="panel-footnote">
        每次保存、定稿和恢复都会留下完整记忆。可预览并恢复适用于当前正文的版本；恢复前自动备份当前记忆，章节正文不会改动。
      </p>
      {versions.length ? (
        <div className="memory-history">
          <ol className="memory-timeline" aria-label="记忆历史版本">
            {versions.map(item => (
              <li key={item.id}>
                <button
                  className={item.id === version?.id ? 'active' : ''}
                  disabled={locked}
                  onClick={() => onSelect(item.id)}
                >
                  <strong>{memoryVersionLabels[item.kind] || item.kind}</strong>
                  <span>
                    {throughLabel(item.memory_through_chapter)} · {new Date(item.created_at).toLocaleString()}
                  </span>
                  {!item.restorable && <Tag bordered={false}>仅供查看</Tag>}
                </button>
              </li>
            ))}
          </ol>
          <div className="memory-history-preview">
            {version ? (
              <>
                <p className="panel-footnote">
                  {version.title || memoryVersionLabels[version.kind] || version.kind} · {version.created_by}
                </p>
                <pre className="memory-snapshot-preview">{version.memory || '（当时的 Memory 为空）'}</pre>
                {!version.restorable && <Alert type="info" showIcon message={version.restore_reason} />}
                <Button
                  type="primary"
                  disabled={locked || !version.restorable}
                  onClick={() => onPreviewRestore(version.id)}
                  style={{ marginTop: 12 }}
                >
                  预览恢复此版本
                </Button>
              </>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择左侧版本查看" />
            )}
          </div>
        </div>
      ) : (
        <Empty description="尚无记忆历史" />
      )}
    </Drawer>
  )
}

export function MemoryRestoreModal({
  restore,
  locked,
  onConfirm,
  onCancel,
}: {
  restore: MemoryRestore | null
  locked: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      title={restore?.target_chapter ? `重写第 ${restore.target_chapter} 章 · 恢复章前记忆` : '恢复历史 Memory'}
      open={Boolean(restore)}
      width={960}
      onCancel={() => !locked && onCancel()}
      onOk={onConfirm}
      okText="备份当前记忆并恢复"
      cancelText="暂不恢复"
      confirmLoading={locked}
      okButtonProps={{ disabled: locked || !restore?.restorable }}
      cancelButtonProps={{ disabled: locked }}
      closable={!locked}
      maskClosable={!locked}
    >
      {restore &&
        (restore.restorable ? (
          <>
            <p className="modal-description">
              将恢复到
              {restore.memory_through_chapter === 0 ? '开篇之前' : `第 ${restore.memory_through_chapter} 章结束`}
              的记忆，并保存当前项目设置。原有记忆和未保存的记忆编辑会先备份；恢复不改动任何章节正文。
            </p>
            {restore.empty_opening && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message="没有可用的开篇前快照。可明确选择使用空 Memory 从第一章重新开始；人物与世界设定仍保留。"
              />
            )}
            <div className="comparison">
              <div>
                <h4>当前记忆 · 将保留备份</h4>
                <pre>{restore.settings.memory || '（空记忆）'}</pre>
              </div>
              <div>
                <h4>恢复后的记忆</h4>
                <pre>{restore.memory || '（空记忆）'}</pre>
              </div>
            </div>
          </>
        ) : (
          <Alert type="warning" showIcon message="暂时没有可恢复的章前记忆" description={restore.restore_reason} />
        ))}
    </Modal>
  )
}
