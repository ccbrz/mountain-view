import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Collapse, Input, Modal, Space, Spin, Tag, Typography, Upload, message } from 'antd'
import { PlusOutlined, UploadOutlined } from '@ant-design/icons'
import api from '../../api'

const { TextArea } = Input
const { Text } = Typography

interface StyleProfile {
  version: 1
  samples: {
    id: string
    source: number
    start: number
    text: string
    enabled: boolean
    manual?: boolean
    preferred?: boolean
  }[]
  observations: {
    advice: string
    sample_id: string
    quote: string
    kind: string
    dimension?: string
    evidence?: { sample_id: string; quote: string }[]
  }[]
}
interface StyleCandidate {
  style_guide: string
  profile: StyleProfile
  base_revision: string
  skipped_count?: number
  missing_dimensions?: string[]
}

function StyleReferenceBank({
  profile,
  onChange,
  disabled,
}: {
  profile: StyleProfile | null
  onChange: (next: StyleProfile) => void
  disabled: boolean
}) {
  const bank: StyleProfile = profile || { version: 1, samples: [], observations: [] }
  const update = (id: string, patch: Partial<StyleProfile['samples'][number]>) =>
    onChange({ ...bank, samples: bank.samples.map(sample => (sample.id === id ? { ...sample, ...patch } : sample)) })
  const remove = (id: string) =>
    onChange({
      ...bank,
      samples: bank.samples.filter(sample => sample.id !== id),
      observations: bank.observations.flatMap(item => {
        const evidence = (item.evidence || [{ sample_id: item.sample_id, quote: item.quote }]).filter(
          entry => entry.sample_id !== id,
        )
        return evidence.length ? [{ ...item, ...evidence[0], ...(item.evidence ? { evidence } : {}) }] : []
      }),
    })
  return (
    <Collapse
      defaultActiveKey={bank.samples.length ? [] : ['samples']}
      items={[
        {
          key: 'samples',
          label: `参考原文 · ${bank.samples.length} 段`,
          children: (
            <>
              <p className="tool-hint">
                自动提取和手动添加的范文统一保存在这里。每次最多选两段、合计不超过 2000
                字符；优先使用已启用且标记优先的片段，其余按本章内容自动补充。只学写法，不复用事实。
              </p>
              {bank.samples.map((sample, i) => (
                <div key={sample.id} className="style-sample">
                  <Space wrap>
                    <Checkbox
                      aria-label={`启用参考片段${i + 1}`}
                      checked={sample.enabled}
                      disabled={disabled}
                      onChange={e => update(sample.id, { enabled: e.target.checked })}
                    >
                      {sample.manual
                        ? `片段 ${i + 1} · 手动添加`
                        : `${sample.id} · 文件 ${sample.source} · 第 ${sample.start + 1} 字符起`}
                    </Checkbox>
                    <Checkbox
                      aria-label={`优先使用参考片段${i + 1}`}
                      checked={!!sample.preferred}
                      disabled={disabled}
                      onChange={e => update(sample.id, { preferred: e.target.checked })}
                    >
                      优先使用
                    </Checkbox>
                    <Button
                      size="small"
                      type="text"
                      danger
                      aria-label={`删除参考片段${i + 1}`}
                      disabled={disabled}
                      onClick={() => remove(sample.id)}
                    >
                      删除
                    </Button>
                  </Space>
                  {sample.manual ? (
                    <TextArea
                      aria-label={`手动参考片段${i + 1}`}
                      value={sample.text}
                      onChange={e => update(sample.id, { text: e.target.value })}
                      rows={5}
                      maxLength={1000}
                      showCount
                      autoFocus={!sample.text}
                      disabled={disabled}
                      placeholder="粘贴你想参考的原文片段，随后点击上方保存文风。"
                    />
                  ) : (
                    <pre className="style-sample-text">{sample.text}</pre>
                  )}
                  {bank.observations
                    .filter(
                      item =>
                        item.sample_id === sample.id || item.evidence?.some(entry => entry.sample_id === sample.id),
                    )
                    .map((item, n) => (
                      <p key={n} className="style-observation">
                        <Tag bordered={false}>{item.dimension || item.kind}</Tag>
                        {item.advice}
                        {(item.evidence || [{ sample_id: item.sample_id, quote: item.quote }])
                          .filter(entry => entry.sample_id === sample.id)
                          .map((entry, j) => (
                            <Text key={j} type="secondary" className="style-evidence">
                              依据：「{entry.quote}」
                            </Text>
                          ))}
                      </p>
                    ))}
                </div>
              ))}
              <Button
                aria-label="添加参考片段"
                icon={<PlusOutlined />}
                disabled={
                  disabled || bank.samples.filter(sample => sample.manual).length >= 12 || bank.samples.length >= 24
                }
                onClick={() =>
                  onChange({
                    ...bank,
                    samples: [
                      ...bank.samples,
                      {
                        id: 'manual-' + crypto.randomUUID(),
                        source: 0,
                        start: 0,
                        text: '',
                        enabled: true,
                        manual: true,
                        preferred: true,
                      },
                    ],
                  })
                }
              >
                添加参考片段
              </Button>
              <p className="tool-hint">手动片段每段最多 1000 字符，最多 12 段；增删、启停与优先设置随文风一起保存。</p>
            </>
          ),
        },
      ]}
    />
  )
}

function readTextFile(file: File): Promise<string> {
  return file.arrayBuffer().then(buffer => {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
    return utf8.includes('\uFFFD') ? new TextDecoder('gbk', { fatal: false }).decode(buffer) : utf8
  })
}

/** Style guide and reference passages. Extraction is a preview; only explicit adoption changes the saved style. */
export default function StyleStudio({ novelId, onSaved }: { novelId: string; onSaved: () => void }) {
  const [styleGuide, setStyleGuide] = useState('')
  const [source, setSource] = useState('')
  const [profile, setProfile] = useState<StyleProfile | null>(null)
  const [revision, setRevision] = useState('')
  const [candidate, setCandidate] = useState<StyleCandidate | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api
      .get(`/novels/${novelId}/style/profile`)
      .then(({ data }) => {
        setStyleGuide(data.style_guide || '')
        setProfile(data.profile)
        setRevision(data.revision)
      })
      .catch(e => setError(e.response?.data?.message || '文风加载失败'))
  }, [novelId])

  const extract = async () => {
    if (source.trim().length < 100) {
      message.error('范文太短，请至少提供 100 字以上的文本')
      return
    }
    setExtracting(true)
    try {
      const res = await api.post(`/novels/${novelId}/style/guide`, { content: source })
      setCandidate(res.data)
    } catch (err: any) {
      message.error('文风提取失败：' + (err.response?.data?.message || err.message))
    } finally {
      setExtracting(false)
    }
  }

  const save = async (next?: StyleCandidate) => {
    setSaving(true)
    try {
      const { data } = await api.put(
        `/novels/${novelId}/style/guide`,
        next || { style_guide: styleGuide, profile, base_revision: revision },
      )
      setStyleGuide(data.style_guide)
      setProfile(data.profile)
      setRevision(data.revision)
      setCandidate(null)
      onSaved()
      message.success('文风已保存，后续生成使用这份指南与已启用范文')
    } catch (err: any) {
      message.error(err.response?.data?.message || err.message)
    } finally {
      setSaving(false)
    }
  }

  const locked = saving || extracting || !!candidate
  return (
    <div className="tool-stack">
      {error && <Alert type="error" showIcon message={error} />}
      <section className="tool-section">
        <div className="tool-section-heading">
          <div>
            <h3>从范文提炼文风</h3>
            <p>上传或粘贴范文，提炼叙述语气、对白口吻与场景、外貌、动作的写法。使用写作台「参数」中的创作模型。</p>
          </div>
          <Button aria-label="提取文风指南" type="primary" loading={extracting} disabled={extracting} onClick={extract}>
            {extracting ? '提取中…' : '提取文风指南'}
          </Button>
        </div>
        <Spin spinning={extracting} tip="正在分析文风…">
          <Upload
            accept=".txt"
            multiple
            showUploadList={false}
            beforeUpload={file => {
              void readTextFile(file).then(text => setSource(prev => (prev ? prev + '\n\n---\n\n' + text : text)))
              return false
            }}
          >
            <Button icon={<UploadOutlined />}>选择 .txt 文件</Button>
          </Upload>
          <TextArea
            value={source}
            onChange={e => setSource(e.target.value)}
            rows={7}
            placeholder="选择文件后内容会出现在这里，也可以直接粘贴范文。多份文件会分散取样，确认前不会覆盖已保存的文风。"
            style={{ marginTop: 12 }}
          />
        </Spin>
      </section>

      <section className="tool-section">
        <div className="tool-section-heading">
          <div>
            <h3>文风指南</h3>
            <p>完整用于正文生成。本次要求与作者批注优先；留空可停用指南。</p>
          </div>
          <Button
            aria-label="保存文风"
            loading={saving}
            disabled={!revision || extracting || !!candidate}
            onClick={() => save()}
          >
            保存文风
          </Button>
        </div>
        <TextArea
          aria-label="文风指南"
          value={styleGuide}
          onChange={e => setStyleGuide(e.target.value)}
          rows={10}
          maxLength={20000}
          disabled={locked}
          placeholder="可以填写叙述语气、对白口吻，以及场景、外貌和动作的描写偏好，也可以从范文提取后编辑。"
        />
        <div style={{ marginTop: 16 }}>
          <StyleReferenceBank profile={profile} onChange={setProfile} disabled={locked} />
        </div>
      </section>

      <Modal
        title="文风候选 · 确认后启用"
        open={!!candidate}
        width={900}
        maskClosable={false}
        onCancel={() => !saving && setCandidate(null)}
        footer={
          <Space>
            <Button disabled={saving} onClick={() => setCandidate(null)}>
              放弃候选
            </Button>
            <Button type="primary" loading={saving} onClick={() => candidate && save(candidate)}>
              采纳并保存文风
            </Button>
          </Space>
        }
      >
        <p className="tool-hint">
          提炼后的写法建议可以直接修改；原文依据收在「参考原文」里，不会拼进指南。确认保存后才启用。
        </p>
        {!!candidate?.skipped_count && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`保留 ${candidate.profile.observations.length} 条有原文依据的建议，另有 ${candidate.skipped_count} 条不符合写法范围或依据规范，已跳过。`}
          />
        )}
        {!!candidate?.missing_dimensions?.length && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`本次未提炼到：${candidate.missing_dimensions.join('、')}。可补充对应描写的范文后重新提取。`}
          />
        )}
        <TextArea
          aria-label="候选文风指南"
          value={candidate?.style_guide || ''}
          maxLength={20000}
          rows={10}
          disabled={saving}
          onChange={e => setCandidate(current => current && { ...current, style_guide: e.target.value })}
        />
        <div style={{ marginTop: 16 }}>
          <StyleReferenceBank
            profile={candidate?.profile || null}
            onChange={next => setCandidate(current => current && { ...current, profile: next })}
            disabled={saving}
          />
        </div>
      </Modal>
    </div>
  )
}
