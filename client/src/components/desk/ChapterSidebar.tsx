import type { CSSProperties } from 'react'
import { Button, Dropdown, Tooltip } from 'antd'
import {
  ArrowLeftOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  HistoryOutlined,
  LoadingOutlined,
  MoreOutlined,
  PictureOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import BrandMark from '../BrandMark'
import { formatCount, type ChapterItem } from './types'

export type ChapterAction = 'rename' | 'versions' | 'background' | 'delete'

function chapterState(item: ChapterItem, unsaved: boolean) {
  if (unsaved) return { label: '尚未保存', tone: 'pending' }
  if (item.status === 'finalized') return { label: '已定稿', tone: 'done' }
  if (item.status === 'needs_review') return { label: '待核对', tone: 'review' }
  if (item.has_content) return { label: '草稿', tone: 'draft' }
  return { label: '等待落笔', tone: 'empty' }
}

export default function ChapterSidebar({
  novelTitle,
  chapters,
  chapterIdx,
  currentTitle,
  chapterDirty,
  disabled,
  navigationDisabled,
  mobileOpen,
  onCloseMobile,
  onBack,
  onOpenSettings,
  onNewChapter,
  onSelect,
  onAction,
  onDownload,
  backgrounds,
  pendingBackgrounds,
}: {
  novelTitle: string
  chapters: ChapterItem[]
  chapterIdx: number
  currentTitle: string
  chapterDirty: boolean
  /** A request or save is in flight. */
  disabled: boolean
  /** Leaving the chapter is blocked (busy, or an unsaved local draft is awaiting recovery). */
  navigationDisabled: boolean
  mobileOpen: boolean
  onCloseMobile: () => void
  onBack: () => void
  onOpenSettings: () => void
  onNewChapter: () => void
  onSelect: (idx: number) => void
  onAction: (item: ChapterItem, action: ChapterAction) => void
  onDownload: (format: 'txt' | 'md' | 'json') => void
  /** Object URLs of generated chapter backgrounds, keyed by chapter number. */
  backgrounds: Record<number, string>
  pendingBackgrounds: Set<number>
}) {
  const totalWords = chapters.reduce((sum, item) => sum + (item.word_count || 0), 0)
  return (
    <aside className={`library-panel ${mobileOpen ? 'mobile-open' : ''}`}>
      <Button
        className="mobile-only panel-close"
        type="text"
        icon={<CloseOutlined />}
        aria-label="关闭章节侧栏"
        onClick={onCloseMobile}
      />
      <Button
        className="back-to-library"
        type="text"
        size="small"
        icon={<ArrowLeftOutlined />}
        disabled={navigationDisabled}
        onClick={onBack}
      >
        返回书架
      </Button>
      <div className="brand">
        <BrandMark size={38} />
        <div className="book-identity">
          <Tooltip title="作品设置" placement="right">
            <button
              className="book-settings-trigger"
              aria-label="作品设置"
              disabled={navigationDisabled}
              onClick={onOpenSettings}
            >
              <strong title={novelTitle}>{novelTitle}</strong>
              <SettingOutlined />
            </button>
          </Tooltip>
          <span>
            {chapters.length} 章 · {formatCount(totalWords)} 字
          </span>
        </div>
      </div>

      <div className="library-heading">
        <span>章节</span>
        <Tooltip title="新建章节">
          <Button
            aria-label="新建章节"
            type="text"
            size="small"
            icon={<PlusOutlined />}
            disabled={disabled}
            onClick={onNewChapter}
          />
        </Tooltip>
      </div>

      <nav className="chapter-list" aria-label="章节列表">
        {chapters.map(item => {
          const active = item.chapter_idx === chapterIdx
          const state = chapterState(item, active && chapterDirty)
          return (
            <div key={item.chapter_idx} className={`chapter-row ${active ? 'active' : ''}`}>
              <button
                disabled={disabled}
                className={[
                  'chapter-card',
                  active && 'active',
                  backgrounds[item.chapter_idx] && 'has-background',
                  pendingBackgrounds.has(item.chapter_idx) && 'background-pending',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={
                  backgrounds[item.chapter_idx]
                    ? ({ '--chapter-bg': `url(${backgrounds[item.chapter_idx]})` } as CSSProperties)
                    : undefined
                }
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelect(item.chapter_idx)}
              >
                <span className="chapter-number">第 {item.chapter_idx} 章</span>
                <strong>{(active ? currentTitle : item.title) || '未命名章节'}</strong>
                <span className="chapter-meta">
                  <span className={`chapter-state ${state.tone}`}>{state.label}</span>
                  {!!item.word_count && <span>{formatCount(item.word_count)} 字</span>}
                  {pendingBackgrounds.has(item.chapter_idx) && (
                    <span className="portrait-status">
                      <LoadingOutlined /> 生成背景图
                    </span>
                  )}
                </span>
              </button>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'rename', label: '重命名', icon: <EditOutlined /> },
                    { key: 'versions', label: '台本版本', icon: <HistoryOutlined /> },
                    {
                      key: 'background',
                      label: backgrounds[item.chapter_idx] ? '重新生成背景图' : '生成背景图',
                      icon: <PictureOutlined />,
                      disabled: pendingBackgrounds.has(item.chapter_idx),
                    },
                    { type: 'divider' as const },
                    { key: 'delete', label: '删除章节', danger: true, icon: <DeleteOutlined /> },
                  ],
                  onClick: ({ key }) => onAction(item, key as ChapterAction),
                }}
              >
                <Button
                  className="chapter-menu"
                  type="text"
                  size="small"
                  aria-label={`第 ${item.chapter_idx} 章操作`}
                  icon={<MoreOutlined />}
                  disabled={navigationDisabled}
                />
              </Dropdown>
            </div>
          )
        })}
        <button className="chapter-add" disabled={disabled} onClick={onNewChapter}>
          <PlusOutlined /> 新建章节
        </button>
      </nav>

      <div className="library-footer">
        <Dropdown
          trigger={['click']}
          disabled={disabled}
          menu={{
            items: [
              { key: 'txt', label: '下载全书 TXT' },
              { key: 'md', label: '下载 Markdown' },
              { type: 'divider' as const },
              { key: 'json', label: '备份项目 JSON' },
            ],
            onClick: ({ key }) => onDownload(key as 'txt' | 'md' | 'json'),
          }}
        >
          <Button block icon={<DownloadOutlined />}>
            导出与备份
          </Button>
        </Dropdown>
      </div>
    </aside>
  )
}
