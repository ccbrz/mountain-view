import { useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Button, Drawer, Tooltip } from 'antd'
import { BookOutlined, LogoutOutlined, MenuOutlined, TeamOutlined } from '@ant-design/icons'
import { useAuth } from '../context/AuthContext'
import BrandMark from '../components/BrandMark'
import './MainLayout.css'

export default function MainLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)

  const items = [
    { key: '/books', icon: <BookOutlined />, label: '书架' },
    ...(user?.role === 'admin' ? [{ key: '/permissions', icon: <TeamOutlined />, label: '成员与权限' }] : []),
  ]

  const nav = (
    <div className="shell-nav">
      <div className="shell-brand">
        <BrandMark size={34} />
        <div>
          <strong>Mountain View</strong>
          <span>长篇写作台</span>
        </div>
      </div>
      <nav className="shell-menu" aria-label="主导航">
        {items.map(item => (
          <button
            key={item.key}
            className={`shell-menu-item ${location.pathname === item.key ? 'active' : ''}`}
            aria-current={location.pathname === item.key ? 'page' : undefined}
            onClick={() => {
              navigate(item.key)
              setMobileOpen(false)
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="shell-user">
        <span className="shell-avatar">{user?.username.slice(0, 1).toUpperCase()}</span>
        <div className="shell-user-meta">
          <strong>{user?.username}</strong>
          <span>{user?.role === 'admin' ? '管理员' : '作者'}</span>
        </div>
        <Tooltip title="退出登录">
          <Button type="text" aria-label="退出登录" icon={<LogoutOutlined />} onClick={logout} />
        </Tooltip>
      </div>
    </div>
  )

  return (
    <div className="shell">
      <aside className="shell-sider">{nav}</aside>
      <header className="shell-mobile-bar">
        <Button type="text" aria-label="打开导航" icon={<MenuOutlined />} onClick={() => setMobileOpen(true)} />
        <BrandMark size={26} />
        <strong>Mountain View</strong>
      </header>
      <Drawer
        placement="left"
        width={260}
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        closable={false}
        styles={{ body: { padding: 0 } }}
      >
        {nav}
      </Drawer>
      <main className="shell-content">
        <Outlet />
      </main>
    </div>
  )
}
