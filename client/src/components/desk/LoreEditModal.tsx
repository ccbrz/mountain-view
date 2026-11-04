import { useEffect, useState } from 'react'
import { Button, Input, Modal, Popconfirm, Switch, Tag, message } from 'antd'
import { BulbOutlined, CloseOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { proseLength, type LoreEntry } from './types'

const KEY_LIMIT = 'Lorebook 条目最多 100 个触发词，每个不超过 500 字符'

/** Adds a pending trigger-word draft to the list; returns null when the limits are exceeded. */
function withDraft(keys: string[], draft: string | null) {
  const key = draft?.trim()
  if (!key || keys.some(existing => existing.trim().toLocaleLowerCase() === key.toLocaleLowerCase())) return keys
  if (keys.length >= 100 || key.length > 500) return null
  return [...keys, key]
}

export function LoreEditModal({
  entry,
  exists,
  locked,
  polishing,
  polishOpen,
  modelName,
  onChange,
  onSave,
  onCancel,
  onDelete,
  onPolish,
}: {
  entry: LoreEntry | null
  exists: boolean
  locked: boolean
  polishing: boolean
  polishOpen: boolean
  modelName: string
  onChange: (entry: LoreEntry) => void
  onSave: (entry: LoreEntry) => void
  onCancel: () => void
  onDelete: () => void
  onPolish: () => void
}) {
  const [keyDraft, setKeyDraft] = useState<string | null>(null)
  useEffect(() => setKeyDraft(null), [entry?.id])
  const frozen = locked || polishOpen

  const addKey = () => {
    if (!entry || frozen) return
    const keys = withDraft(entry.keys, keyDraft)
    if (!keys) return void message.warning(KEY_LIMIT)
    onChange({ ...entry, keys })
    setKeyDraft(null)
  }

  const save = () => {
    if (!entry?.title.trim() || !entry.text.trim()) return void message.warning('请填写条目名称和设定正文')
    const keys = withDraft(entry.keys, keyDraft)
    if (!keys) return void message.warning(KEY_LIMIT)
    const cleaned = { ...entry, keys: Array.from(new Set(keys.map(key => key.trim()).filter(Boolean))) }
    if (cleaned.keys.length > 100 || cleaned.keys.some(key => key.length > 500)) return void message.warning(KEY_LIMIT)
    onSave(cleaned)
  }

  return (
    <Modal
      title={exists ? '编辑设定条目' : '新增设定条目'}
      open={Boolean(entry)}
      okText="完成编辑"
      cancelText="取消"
      onOk={save}
      onCancel={() => !locked && onCancel()}
      width={640}
      destroyOnHidden
      maskClosable={!frozen}
      closable={!frozen}
      okButtonProps={{ disabled: frozen }}
      cancelButtonProps={{ disabled: frozen }}
    >
      {entry && (
        <fieldset className="modal-form lore-edit-form" disabled={frozen}>
          <div className="modal-form-row">
            <label>
              条目名称
              <Input
                aria-label="条目名称"
                maxLength={500}
                value={entry.title}
                onChange={e => onChange({ ...entry, title: e.target.value })}
              />
            </label>
            <label>
              分类
              <Input
                aria-label="设定分类"
                maxLength={200}
                placeholder="人物、地点、世界规则…"
                value={entry.category}
                onChange={e => onChange({ ...entry, category: e.target.value })}
              />
            </label>
          </div>
          <label>
            设定正文
            <Input.TextArea
              aria-label="设定正文"
              maxLength={50000}
              autoSize={{ minRows: 8, maxRows: 18 }}
              value={entry.text}
              onChange={e => onChange({ ...entry, text: e.target.value })}
            />
          </label>
          <div className="lore-polish-actions">
            <Button
              icon={<BulbOutlined />}
              disabled={locked || !entry.text.trim() || !entry.title.trim()}
              loading={polishing}
              onClick={onPolish}
            >
              AI 整理润色
            </Button>
            <span className="panel-footnote">{modelName} · 保留事实、增强描写，先预览再采纳</span>
          </div>
          <div className="lore-keywords">
            <span id="lore-keywords-label">触发词</span>
            <div className="lore-keyword-tags" role="group" aria-labelledby="lore-keywords-label">
              {entry.keys.map((key, index) => (
                <Tag className="lore-keyword-tag" key={`${index}:${key}`}>
                  <span>{key}</span>
                  <button
                    type="button"
                    aria-label={`删除触发词 ${key}`}
                    disabled={frozen}
                    onClick={() => onChange({ ...entry, keys: entry.keys.filter((_, i) => i !== index) })}
                  >
                    <CloseOutlined />
                  </button>
                </Tag>
              ))}
              {keyDraft === null ? (
                <Button
                  size="small"
                  type="dashed"
                  icon={<PlusOutlined />}
                  aria-label="添加触发词"
                  disabled={frozen || entry.keys.length >= 100}
                  onClick={() => setKeyDraft('')}
                >
                  触发词
                </Button>
              ) : (
                <div className="lore-keyword-input">
                  <Input
                    autoFocus
                    size="small"
                    aria-label="新触发词"
                    placeholder="名称或称呼，回车添加"
                    maxLength={500}
                    value={keyDraft}
                    disabled={frozen}
                    onChange={e => setKeyDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.nativeEvent.isComposing) return
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addKey()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        e.stopPropagation()
                        setKeyDraft(null)
                      }
                    }}
                  />
                  <Button
                    size="small"
                    aria-label="确认添加触发词"
                    disabled={frozen || !keyDraft.trim()}
                    onClick={addKey}
                  >
                    添加
                  </Button>
                  <Button
                    size="small"
                    type="text"
                    aria-label="取消添加触发词"
                    icon={<CloseOutlined />}
                    disabled={frozen}
                    onClick={() => setKeyDraft(null)}
                  />
                </div>
              )}
            </div>
            <p className="panel-footnote">任意一个触发词出现时带入此设定；可添加全名、简称或称呼。</p>
          </div>
          <div className="modal-toggles">
            <label>
              启用 <Switch checked={entry.enabled} onChange={enabled => onChange({ ...entry, enabled })} />
            </label>
            <label>
              始终带入 <Switch checked={entry.always_on} onChange={always_on => onChange({ ...entry, always_on })} />
            </label>
            {exists && (
              <Popconfirm
                title="删除此设定条目？"
                description="保存设定前，可重新打开作品恢复已保存版本。"
                okText="删除"
                cancelText="取消"
                onConfirm={onDelete}
              >
                <Button danger type="text" icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
            )}
          </div>
          <p className="panel-footnote">完成编辑后，还需点击顶部「保存设定」才会写入作品。</p>
        </fieldset>
      )}
    </Modal>
  )
}

export function LorePolishModal({
  polish,
  locked,
  onChange,
  onAccept,
  onCancel,
}: {
  polish: { source: LoreEntry; text: string; model: string } | null
  locked: boolean
  onChange: (text: string) => void
  onAccept: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      title="设定整理润色 · 对比确认"
      open={Boolean(polish)}
      width={960}
      onCancel={onCancel}
      onOk={onAccept}
      okText="采纳到条目编辑区"
      cancelText="保留原文"
      okButtonProps={{ disabled: locked || !polish?.text.trim() }}
    >
      {polish && (
        <>
          <p className="modal-description">
            {polish.model} ·
            保留事实、整理结构，并增强已有描述的表现力。请核对事实、限制条件和信息差，采纳后仍可继续编辑。
          </p>
          <div className="comparison">
            <div>
              <h4>原设定 · {proseLength(polish.source.text)} 字</h4>
              <pre>{polish.source.text}</pre>
            </div>
            <div>
              <h4>整理后 · {proseLength(polish.text)} 字</h4>
              <Input.TextArea
                aria-label="整理后的设定"
                rows={16}
                maxLength={50000}
                value={polish.text}
                onChange={e => onChange(e.target.value)}
              />
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}
