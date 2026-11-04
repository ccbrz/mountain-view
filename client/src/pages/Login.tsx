import { useState } from 'react'
import { Button, Form, Input, message } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import BrandMark from '../components/BrandMark'
import './Login.css'

const FEATURES = [
  { title: '台本驱动', text: '你写剧情与对白，AI 按顺序展开成完整章节。' },
  { title: '唯一记忆', text: '全书只有一份作者确认的 Memory，定稿留快照、可回溯。' },
  { title: '改稿可控', text: '精修只出定点补丁，逐条复核后才由你采用。' },
]

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [submitting, setSubmitting] = useState(false)

  const onFinish = async (values: { username: string; password: string }) => {
    setSubmitting(true)
    try {
      await login(values.username, values.password)
      navigate('/')
    } catch (error: any) {
      message.error(error.response?.status === 429 ? error.response.data?.message : '用户名或密码错误')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <section className="login-story">
        <BrandMark size={44} />
        <div>
          <span className="mv-eyebrow">Mountain View · 长篇写作台</span>
          <h1>故事，由你执笔</h1>
          <p className="login-lede">为长篇连载设计的 AI 写作空间：剧情由你决定，细节交给模型，事实始终可核对。</p>
        </div>
        <ul className="login-features">
          {FEATURES.map(feature => (
            <li key={feature.title}>
              <strong>{feature.title}</strong>
              <span>{feature.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="login-card-heading">
            <BrandMark size={36} className="login-mobile-mark" />
            <h2>登录</h2>
            <p>使用管理员分配的账号进入书架</p>
          </div>
          <Form layout="vertical" size="large" onFinish={onFinish} requiredMark={false}>
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" autoFocus />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登录
            </Button>
          </Form>
        </div>
        <p className="login-footnote">会当凌绝顶，一览众山小</p>
      </section>
    </div>
  )
}
