import { Button, Input, InputNumber, Modal, Select, Tag } from 'antd'
import { ApiOutlined, EditOutlined } from '@ant-design/icons'
import { isImageModel, type ModelProfile, type Settings } from './types'

const FIELDS: { key: keyof Settings; label: string; min: number; max: number; step: number; hint: string }[] = [
  {
    key: 'context_tokens',
    label: '上下文容量',
    min: 1024,
    max: 2000000,
    step: 1024,
    hint: '服务商实际窗口（tokens），用于输出预留和自动裁剪。',
  },
  {
    key: 'max_output_tokens',
    label: '单次输出上限',
    min: 128,
    max: 32768,
    step: 128,
    hint: '按模型 token 计算，不等于中文字数。',
  },
  { key: 'temperature', label: '创作变化', min: 0, max: 2, step: 0.05, hint: '较低更稳定，较高带来更多变化。' },
  {
    key: 'recent_context_chars',
    label: '前章正文范围',
    min: 0,
    max: 6000,
    step: 500,
    hint: '带入已保存前章结尾的字符数；0 表示不带入。',
  },
]

export default function ParametersPanel({
  settings,
  models,
  writingTemplate,
  locked,
  onEditSettings,
  onManageModels,
  onOpenStyle,
}: {
  settings: Settings
  models: ModelProfile[]
  writingTemplate: string
  locked: boolean
  onEditSettings: (values: Partial<Settings>) => void
  onManageModels: () => void
  onOpenStyle: () => void
}) {
  return (
    <div className="inspector-content">
      <div className="inspector-intro">
        <span className="mv-eyebrow">Preferences</span>
        <h2>写作参数</h2>
        <p>修改后点击顶部「保存设定」，对全书生效。</p>
      </div>

      <section className={`setting-section ${!settings.model_id ? 'needs-attention' : ''}`} id="desk-model-setting">
        <h3>创作模型</h3>
        <Select
          aria-label="创作模型"
          style={{ width: '100%' }}
          placeholder="选择创作模型"
          value={settings.model_id || undefined}
          disabled={locked}
          status={settings.model_id ? undefined : 'warning'}
          options={models
            .filter(item => !isImageModel(item))
            .map(item => ({ value: item.id, label: `${item.name} · ${item.model}` }))}
          onChange={model_id => onEditSettings({ model_id })}
        />
        <p>生成正文、写前写后核对、选段改写、记忆整理、台本整理与文风提取共用这个模型。</p>
        <Button size="small" icon={<ApiOutlined />} disabled={locked} onClick={onManageModels}>
          管理模型
        </Button>
      </section>

      <section className="setting-section">
        <h3>文风</h3>
        <p>文风指南与范文片段用于整章生成和选段修改，只学写法、不复用事实。</p>
        <Button block icon={<EditOutlined />} disabled={locked} onClick={onOpenStyle}>
          文风与范文
        </Button>
      </section>

      <section className="setting-section">
        <h3>
          固定写作要求{' '}
          <Tag bordered={false} className="quiet-tag">
            可编辑
          </Tag>
        </h3>
        <p>预填通用创作与去 AI 味模板。生成与修订只使用这里的当前文本，删除的规则不会被自动补回。</p>
        <Input.TextArea
          aria-label="固定写作要求"
          disabled={locked}
          autoSize={{ minRows: 8, maxRows: 18 }}
          maxLength={50000}
          value={settings.system_prompt}
          onChange={event => onEditSettings({ system_prompt: event.target.value })}
        />
        <div className="setting-row-end">
          <Button
            size="small"
            type="text"
            disabled={locked || !writingTemplate || settings.system_prompt === writingTemplate}
            onClick={() =>
              Modal.confirm({
                title: '恢复默认写作模板？',
                content: '将替换当前固定写作要求，保存后对全书生效。文风参考和作者批注保留。',
                okText: '恢复默认',
                cancelText: '取消',
                onOk: () => onEditSettings({ system_prompt: writingTemplate }),
              })
            }
          >
            恢复默认模板
          </Button>
        </div>
        <p className="panel-footnote">
          写法冲突时：本次要求与作者批注优先，其次作者自定义要求，再次文风参考，最后是模板中的默认建议。
        </p>
      </section>

      <section className="setting-section parameter-fields">
        <h3>预算与变化</h3>
        {FIELDS.map(field => (
          <div className="parameter-field" key={field.key}>
            <label>
              <span>{field.label}</span>
              <InputNumber
                aria-label={field.label}
                disabled={locked}
                min={field.min}
                max={field.max}
                step={field.step}
                value={settings[field.key] as number}
                onChange={value => value !== null && onEditSettings({ [field.key]: value })}
              />
            </label>
            <p>{field.hint}</p>
          </div>
        ))}
      </section>
    </div>
  )
}
