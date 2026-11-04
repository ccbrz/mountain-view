import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Drawer, Space } from 'antd'
import { ApiOutlined, FileTextOutlined, SettingOutlined } from '@ant-design/icons'
import api from '../api'
import WritingDesk from '../components/WritingDesk'
import OutlineReview from '../components/OutlineReview'
import NovelSettingsForm from '../components/workspace/NovelSettingsForm'
import ModelManager from '../components/workspace/ModelManager'
import StyleStudio from '../components/workspace/StyleStudio'
import DebugDrawer from '../components/workspace/DebugDrawer'
import type { WorkspaceTool } from '../components/desk/types'
import '../components/workspace/workspace.css'

const TOOLS: Record<WorkspaceTool, { icon: JSX.Element; label: string }> = {
  settings: { icon: <SettingOutlined />, label: '作品设置' },
  'llm-configs': { icon: <ApiOutlined />, label: '模型管理' },
  style: { icon: <FileTextOutlined />, label: '文风与范文' },
}

/** The full-screen writing desk plus the book-level tools it opens in drawers. */
export default function NovelWorkspace() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [tool, setTool] = useState<WorkspaceTool | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [outlineReview, setOutlineReview] = useState<{ num: number; tab: 'review' | 'versions' } | null>(null)
  const [deskRefresh, setDeskRefresh] = useState(0)
  const [modelsVersion, setModelsVersion] = useState(0)
  const refreshDesk = () => setDeskRefresh(value => value + 1)

  useEffect(() => {
    api
      .get(`/novels/${id}`)
      .then(({ data }) => setTitle(data.title))
      .catch(() => navigate('/books', { replace: true }))
  }, [id])

  return (
    <>
      {outlineReview && (
        <OutlineReview
          key={`${id}:${outlineReview.num}`}
          novelId={id!}
          chapterNum={outlineReview.num}
          initialTab={outlineReview.tab}
          beforeAction={async () => {}}
          onClose={() => setOutlineReview(null)}
          onApplied={refreshDesk}
        />
      )}
      <WritingDesk
        key={id}
        novelId={id!}
        novelTitle={title || '我的小说'}
        refreshVersion={deskRefresh}
        modelsVersion={modelsVersion}
        onBack={() => navigate('/books')}
        onOpenTool={setTool}
        onDebug={() => setDebugOpen(true)}
        onOutlineReview={num => setOutlineReview({ num, tab: 'review' })}
        onOutlineVersions={num => setOutlineReview({ num, tab: 'versions' })}
      />
      <Drawer
        className="workspace-tools"
        title={
          tool && (
            <Space>
              {TOOLS[tool].icon}
              {TOOLS[tool].label}
            </Space>
          )
        }
        width="min(960px, 100vw)"
        open={Boolean(tool)}
        onClose={() => setTool(null)}
        extra={<Button onClick={() => setTool(null)}>返回写作</Button>}
        destroyOnHidden
      >
        {tool === 'settings' && (
          <NovelSettingsForm
            novelId={id!}
            onSaved={next => {
              setTitle(next)
              refreshDesk()
            }}
          />
        )}
        {tool === 'llm-configs' && <ModelManager onChange={() => setModelsVersion(value => value + 1)} />}
        {tool === 'style' && <StyleStudio novelId={id!} onSaved={refreshDesk} />}
      </Drawer>
      <DebugDrawer novelId={id!} open={debugOpen} onClose={() => setDebugOpen(false)} />
    </>
  )
}
