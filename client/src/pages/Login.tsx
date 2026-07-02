import { Form, Input, Button, message } from 'antd'
import { UserOutlined, LockOutlined, RiseOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const particles = Array.from({ length: 8 }, (_, i) => ({
  id: i,
  size: 60 + Math.random() * 200,
  left: Math.random() * 100,
  delay: Math.random() * 10,
  duration: 15 + Math.random() * 20,
}))

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()

  const onFinish = async (values: { username: string; password: string }) => {
    try {
      await login(values.username, values.password)
      message.success('登录成功')
      navigate('/')
    } catch {
      message.error('用户名或密码错误')
    }
  }

  return (
    <div style={{
      position: 'relative',
      display: 'flex', justifyContent: 'center', alignItems: 'center',
      minHeight: '100vh',
      overflow: 'hidden',
      background: '#0a0a0a',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    }}>
      <style>{`
        @keyframes float {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0; }
          10% { opacity: 0.15; }
          50% { transform: translate(120px, -80px) scale(1.2); opacity: 0.25; }
          90% { opacity: 0.1; }
        }
        @keyframes float2 {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0; }
          10% { opacity: 0.12; }
          50% { transform: translate(-100px, -60px) scale(1.3); opacity: 0.2; }
          90% { opacity: 0.08; }
        }
        @keyframes float3 {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0; }
          10% { opacity: 0.1; }
          50% { transform: translate(80px, -100px) scale(0.8); opacity: 0.2; }
          90% { opacity: 0.08; }
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        .login-card {
          animation: fadeInUp 0.8s ease-out;
          background: rgba(255, 255, 255, 0.06) !important;
          backdrop-filter: blur(20px) !important;
          -webkit-backdrop-filter: blur(20px) !important;
          border: 1px solid rgba(255, 255, 255, 0.1) !important;
          border-radius: 16px !important;
          box-shadow: 0 25px 60px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
        }
        .login-card .ant-input {
          color: #fff !important;
          background: transparent !important;
        }
        .login-card .ant-input::placeholder {
          color: rgba(255, 255, 255, 0.35) !important;
        }
        .login-card .ant-input-prefix {
          color: rgba(255, 255, 255, 0.4) !important;
          margin-inline-end: 8px !important;
        }
        .login-card .ant-input-affix-wrapper {
          background: rgba(255, 255, 255, 0.08) !important;
          border: 1px solid rgba(255, 255, 255, 0.12) !important;
          border-radius: 8px !important;
          height: 44px;
          padding: 4px 11px !important;
        }
        .login-card .ant-input-affix-wrapper:hover {
          border-color: rgba(255, 200, 100, 0.5) !important;
        }
        .login-card .ant-input-affix-wrapper-focused {
          border-color: rgba(255, 200, 100, 0.6) !important;
          box-shadow: 0 0 0 2px rgba(255, 200, 100, 0.1) !important;
        }
        .login-card .ant-input-suffix {
          color: rgba(255, 255, 255, 0.4) !important;
        }
        .login-card .ant-form-item {
          margin-bottom: 20px;
        }
        .login-card .ant-btn-primary {
          height: 44px;
          background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%) !important;
          border: none !important;
          font-weight: 600;
          font-size: 15px;
          letter-spacing: 1px;
          box-shadow: 0 4px 20px rgba(245, 87, 108, 0.3) !important;
          transition: all 0.3s ease !important;
        }
        .login-card .ant-btn-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 6px 28px rgba(245, 87, 108, 0.45) !important;
        }
        .login-card .ant-message-notice-content {
          background: rgba(0, 0, 0, 0.8) !important;
          backdrop-filter: blur(10px);
          color: #fff !important;
        }
      `}</style>

      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'url(https://images.unsplash.com/photo-1506905925346-21bda4d32df4?auto=format&fit=crop&w=1920&q=80)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        filter: 'brightness(0.5) saturate(1.2)',
      }} />

      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(180deg, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.4) 40%, rgba(0,0,0,0.85) 100%)',
      }} />

      {particles.map((p) => (
        <div key={p.id} style={{
          position: 'absolute',
          bottom: '-10%',
          left: `${p.left}%`,
          width: p.size,
          height: p.size,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,255,255,0.3) 0%, transparent 70%)',
          animation: `${p.id % 3 === 0 ? 'float' : p.id % 3 === 1 ? 'float2' : 'float3'} ${p.duration}s ease-in-out infinite`,
          animationDelay: `${p.delay}s`,
          pointerEvents: 'none',
        }} />
      ))}

      <div style={{
        position: 'relative', zIndex: 1,
        width: 400, maxWidth: '90vw',
      }}>
        <div style={{
          textAlign: 'center', marginBottom: 32,
          animation: 'fadeInUp 0.8s ease-out 0.2s both',
        }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 64, height: 64, borderRadius: 16,
            background: 'linear-gradient(135deg, rgba(240, 147, 251, 0.3), rgba(245, 87, 108, 0.3))',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.15)',
            marginBottom: 16,
            fontSize: 28, color: '#fff',
          }}>
            <RiseOutlined />
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#fff', letterSpacing: 2, marginBottom: 8 }}>
            Mountain View
          </div>
          <div style={{
            fontSize: 14, color: 'rgba(255,255,255,0.6)',
            letterSpacing: 4,
          }}>
            无限风光在险峰
          </div>
        </div>

        <Form
          onFinish={onFinish}
          size="large"
          className="login-card"
          style={{ padding: '8px 8px 0' }}
        >
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" block>登 录</Button>
          </Form.Item>
        </Form>

        <div style={{
          textAlign: 'center', marginTop: 20,
          fontSize: 12, color: 'rgba(255,255,255,0.25)',
          letterSpacing: 1,
          animation: 'fadeInUp 0.8s ease-out 0.4s both',
        }}>
          会当凌绝顶，一览众山小
        </div>
      </div>
    </div>
  )
}
