import { useEffect, useState } from 'react'
import { AutoComplete, Button, Form, Input, InputNumber, message } from 'antd'
import api from '../../api'

const GENRES = ['科幻', '奇幻', '玄幻', '悬疑', '都市', '言情', '历史', '武侠', '恐怖'].map(value => ({ value }))

/** Book-level fields that feed every generation request: title, genre, target length and long-term guidance. */
export default function NovelSettingsForm({ novelId, onSaved }: { novelId: string; onSaved: (title: string) => void }) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.get(`/novels/${novelId}`).then(({ data }) => form.setFieldsValue(data))
  }, [novelId])

  const save = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      await api.put(`/novels/${novelId}`, values)
      message.success('作品设置已保存')
      onSaved(values.title)
    } catch (err: any) {
      message.error(err.response?.data?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="tool-stack">
      <section className="tool-section">
        <div className="tool-section-heading">
          <div>
            <h3>作品设置</h3>
            <p>这些信息会进入每次生成；修改后，基于旧设置的核对结果需要重新生成。</p>
          </div>
        </div>
        <Form form={form} layout="vertical" requiredMark={false} style={{ maxWidth: 560 }}>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, whitespace: true, message: '请输入作品标题' }]}
          >
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="genre" label="类型">
            <AutoComplete options={GENRES} placeholder="科幻 / 悬疑 / 言情…" filterOption />
          </Form.Item>
          <Form.Item
            name="word_number"
            label="每章目标字数"
            extra="篇幅目标为该字数至其 1.25 倍，含标点、不含空白。"
            rules={[{ required: true, message: '请填写每章目标字数' }]}
          >
            <InputNumber min={100} max={50000} step={500} addonAfter="字" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="guidance" label="写作指引" extra="对全书风格、内容走向的长期要求。">
            <Input.TextArea rows={4} maxLength={20000} />
          </Form.Item>
          <Button type="primary" loading={saving} onClick={save}>
            保存设置
          </Button>
        </Form>
      </section>
    </div>
  )
}
