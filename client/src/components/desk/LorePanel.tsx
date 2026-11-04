import { useState, type CSSProperties } from 'react'
import { Button, Empty, Input, Select, Switch, Tag, Tooltip } from 'antd'
import { DownloadOutlined, LoadingOutlined, PictureOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons'
import { isImageModel, type LoreEntry, type ModelProfile, type Settings } from './types'

export default function LorePanel({
  settings,
  models,
  locked,
  portraits,
  pendingPortraits,
  onGeneratePortrait,
  onEditSettings,
  onOpenEntry,
  onNewEntry,
  onImport,
  onExport,
}: {
  settings: Settings
  models: ModelProfile[]
  locked: boolean
  /** Object URLs of generated character portraits, keyed by entry id. */
  portraits: Record<string, string>
  pendingPortraits: Set<string>
  onGeneratePortrait: (entry: LoreEntry) => void
  onEditSettings: (values: Partial<Settings>) => void
  onOpenEntry: (entry: LoreEntry) => void
  onNewEntry: () => void
  onImport: (file: File) => void
  onExport: () => void
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string | undefined>()
  const categories = Array.from(new Set(settings.lorebook.map(entry => entry.category).filter(Boolean)))
  const visible = settings.lorebook.filter(
    entry =>
      (!category || entry.category === category) &&
      `${entry.title}\n${entry.category}\n${entry.keys.join(' ')}`.toLowerCase().includes(search.toLowerCase()),
  )
  const active = settings.lorebook.filter(entry => entry.enabled).length
  const textModels = models.filter(item => !isImageModel(item))
  const imageModels = models.filter(isImageModel)

  return (
    <div className="inspector-content">
      <div className="inspector-intro">
        <span className="mv-eyebrow">World & Characters</span>
        <h2>设定集</h2>
        <p>
          世界观、人物、地点与规则。触发词出现在台本、批注或附近正文时带入写作；常驻条目始终带入。共{' '}
          {settings.lorebook.length} 条，启用 {active} 条。
        </p>
      </div>

      <div className="lore-toolbar">
        <Input.Search
          aria-label="搜索设定"
          placeholder="搜索名称、分类或触发词"
          allowClear
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        {categories.length > 0 && (
          <div className="lore-filter" role="group" aria-label="设定分类">
            {[undefined, ...categories].map(value => (
              <button
                key={value || 'all'}
                className={`lore-chip ${category === value ? 'active' : ''}`}
                onClick={() => setCategory(value)}
              >
                {value || '全部'}
              </button>
            ))}
          </div>
        )}
        <div className="lore-actions">
          <Button type="primary" icon={<PlusOutlined />} disabled={locked} onClick={onNewEntry}>
            新增条目
          </Button>
          <Tooltip title="导入 Lorebook JSON">
            <label className={`import-label ${locked ? 'disabled' : ''}`}>
              <UploadOutlined />
              <input
                aria-label="导入设定 JSON"
                type="file"
                accept=".json,application/json"
                disabled={locked}
                onChange={event => {
                  const file = event.target.files?.[0]
                  if (file) onImport(file)
                  event.target.value = ''
                }}
              />
            </label>
          </Tooltip>
          <Tooltip title="导出 Lorebook JSON">
            <Button
              type="text"
              aria-label="导出设定"
              icon={<DownloadOutlined />}
              disabled={locked}
              onClick={onExport}
            />
          </Tooltip>
        </div>
      </div>

      <div className="lore-list">
        {visible.map(entry => (
          <div
            key={entry.id}
            className={[
              'lore-card',
              !entry.enabled && 'disabled-lore',
              portraits[entry.id] && 'has-portrait',
              pendingPortraits.has(entry.id) && 'portrait-pending',
            ]
              .filter(Boolean)
              .join(' ')}
            style={portraits[entry.id] ? ({ '--portrait': `url(${portraits[entry.id]})` } as CSSProperties) : undefined}
          >
            <div className="lore-card-heading">
              <button
                className="lore-title"
                disabled={locked}
                onClick={() => onOpenEntry({ ...entry, keys: [...entry.keys] })}
              >
                {entry.title || '未命名条目'}
              </button>
              <Tooltip
                title={
                  !settings.image_model_id
                    ? '先在本页底部选择生图模型'
                    : portraits[entry.id]
                      ? '重新生成背景图'
                      : '生成背景图'
                }
              >
                <Button
                  type="text"
                  size="small"
                  className="lore-image-button"
                  aria-label={`为${entry.title || '条目'}生成背景图`}
                  icon={pendingPortraits.has(entry.id) ? <LoadingOutlined /> : <PictureOutlined />}
                  disabled={pendingPortraits.has(entry.id) || !entry.text.trim()}
                  onClick={() => onGeneratePortrait(entry)}
                />
              </Tooltip>
              <Switch
                aria-label={`启用${entry.title}`}
                size="small"
                disabled={locked}
                checked={entry.enabled}
                onChange={enabled =>
                  onEditSettings({
                    lorebook: settings.lorebook.map(item => (item.id === entry.id ? { ...item, enabled } : item)),
                  })
                }
              />
            </div>
            <p>{entry.text}</p>
            <div className="lore-tags">
              {entry.category && <Tag bordered={false}>{entry.category}</Tag>}
              {entry.always_on ? (
                <Tag color="gold" bordered={false}>
                  常驻
                </Tag>
              ) : (
                entry.keys.slice(0, 3).map(key => (
                  <Tag key={key} bordered={false} className="lore-key">
                    {key}
                  </Tag>
                ))
              )}
              {!entry.always_on && !entry.keys.length && <span className="quiet-label">尚未设置触发词</span>}
              {pendingPortraits.has(entry.id) && (
                <span className="portrait-status">
                  <LoadingOutlined /> 正在生成背景
                </span>
              )}
            </div>
          </div>
        ))}
        {!visible.length && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              settings.lorebook.length ? '没有匹配的设定' : '还没有设定。新增人物或世界观条目，写作时按触发词带入。'
            }
          />
        )}
      </div>

      <section className="setting-section">
        <h3>设定整理模型</h3>
        <Select
          aria-label="设定生成模型"
          style={{ width: '100%' }}
          disabled={locked}
          value={settings.lore_model_id || ''}
          options={[
            { value: '', label: '跟随创作模型' },
            ...textModels.map(item => ({ value: item.id, label: `${item.name} · ${item.model}` })),
          ]}
          onChange={lore_model_id => onEditSettings({ lore_model_id })}
        />
        <p>条目编辑中的「AI 整理润色」与人物形象的画面描述使用此模型，只发送该条目本身。</p>
      </section>

      <section className="setting-section">
        <h3>
          <PictureOutlined style={{ marginRight: 8 }} />
          条目背景图
        </h3>
        <Select
          aria-label="生图模型"
          style={{ width: '100%' }}
          disabled={locked}
          value={settings.image_model_id || ''}
          options={[
            { value: '', label: '不使用生图' },
            ...imageModels.map(item => ({ value: item.id, label: `${item.name} · ${item.model}` })),
          ]}
          onChange={image_model_id => onEditSettings({ image_model_id })}
        />
        <p>
          选择后，点击条目卡片上的图片按钮生成背景图：人物条目生成人物形象，其他条目生成场景。画面描述只取自条目内容，不进入写作上下文。
          {!imageModels.length && ' 还没有生图模型，可在「参数 → 管理模型」中添加 NovelAI Image 配置。'}
        </p>
        {settings.image_model_id && (
          <p className="panel-footnote">
            {settings.lorebook.filter(entry => portraits[entry.id]).length} / {settings.lorebook.length}{' '}
            个条目已有背景图。单张 1216×832、28 步，在 NovelAI Opus 免费额度内。
          </p>
        )}
      </section>
    </div>
  )
}
