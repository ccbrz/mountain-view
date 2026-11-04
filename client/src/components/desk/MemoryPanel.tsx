import { Button, Input, Tooltip } from 'antd'
import { BulbOutlined, ExpandOutlined, HistoryOutlined, RollbackOutlined } from '@ant-design/icons'
import type { Settings } from './types'

export default function MemoryPanel({
  settings,
  locked,
  navigationDisabled,
  chapterDirty,
  hasContent,
  onChange,
  onExpand,
  onHistory,
  onRestoreBeforeChapter,
  onSuggest,
}: {
  settings: Settings
  locked: boolean
  navigationDisabled: boolean
  chapterDirty: boolean
  hasContent: boolean
  onChange: (memory: string) => void
  onExpand: () => void
  onHistory: () => void
  onRestoreBeforeChapter: () => void
  onSuggest: () => void
}) {
  const through = settings.memory_through_chapter
  return (
    <div className="inspector-content">
      <div className="inspector-intro">
        <span className="mv-eyebrow">Book Memory</span>
        <h2>全书记忆</h2>
        <p>全书唯一的当前有效记忆，生成、审稿与台本整理共用；切换章节不会更换。本章的特别提醒请写在作者批注里。</p>
      </div>

      <div className="memory-status">
        <span className={`memory-progress ${through === undefined ? 'unknown' : ''}`} aria-label="记忆进度">
          {through === undefined ? '进度尚未确认' : through === 0 ? '开篇之前' : `截至第 ${through} 章结束`}
        </span>
        <div className="section-tools">
          <Button type="text" size="small" icon={<HistoryOutlined />} disabled={locked} onClick={onHistory}>
            历史
          </Button>
          <Tooltip title="展开编辑">
            <Button
              aria-label="展开 Memory"
              type="text"
              size="small"
              icon={<ExpandOutlined />}
              disabled={locked}
              onClick={onExpand}
            />
          </Tooltip>
        </div>
      </div>

      <Input.TextArea
        aria-label="Memory"
        className="memory-editor"
        autoSize={{ minRows: 10, maxRows: 22 }}
        disabled={locked}
        maxLength={100000}
        value={settings.memory}
        placeholder="记录已经发生的事实：人物状态、物品归属、谁知道什么、未解的线索。区分猜测与已证实的信息。"
        onChange={event => onChange(event.target.value)}
      />

      <div className="stacked-actions">
        <Tooltip
          title={chapterDirty ? '等待本章自动保存完成，再整理记忆' : '根据已保存正文生成建议，确认后才更新 Memory'}
        >
          <Button block icon={<BulbOutlined />} disabled={locked || chapterDirty || !hasContent} onClick={onSuggest}>
            根据本章正文整理建议
          </Button>
        </Tooltip>
        <Tooltip title="回头重写已定稿章节时，预览并恢复该章开始前的记忆；当前版本会先备份。">
          <Button block icon={<RollbackOutlined />} disabled={navigationDisabled} onClick={onRestoreBeforeChapter}>
            重写本章 · 恢复章前记忆
          </Button>
        </Tooltip>
      </div>
      <p className="panel-footnote">
        定稿时自动整理记忆建议，核对后与定稿一起保存并留下历史快照。历史版本只读，不会自动混入请求。
      </p>
    </div>
  )
}
