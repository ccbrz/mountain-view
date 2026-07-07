import { useState } from 'react'
import { useNavigate, useLocation, Outlet } from 'react-router-dom'
import { Layout, Menu, Button, Typography, Avatar, Dropdown, Space } from 'antd'
import {
  TeamOutlined,
  EditOutlined,
  LogoutOutlined,
  UserOutlined,
  RiseOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons'
import { useAuth } from '../context/AuthContext'

const { Sider, Header, Content } = Layout
const { Text } = Typography

export default function MainLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(window.innerWidth < 992)

  const isAdmin = user?.role === 'admin'

  const menuItems = [
    ...(isAdmin
      ? [{ key: '/permissions', icon: <TeamOutlined />, label: '权限管理' }]
      : []),
    { key: '/fantasy', icon: <EditOutlined />, label: '幻想小说家' },
  ]

  const currentKey = menuItems.some((item) => item.key === location.pathname)
    ? location.pathname
    : (menuItems[0]?.key || '/fantasy')

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="dark"
        width={220}
        breakpoint="lg"
        collapsedWidth={0}
        trigger={null}
        style={{ borderRight: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div style={{
          height: 64, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
          <RiseOutlined style={{ fontSize: 22, color: '#f093fb' }} />
          {!collapsed && <Text strong style={{ color: '#fff', fontSize: 16 }}>Mountain View</Text>}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[currentKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header style={{
          background: '#fff', display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', padding: '0 24px',
          borderBottom: '1px solid #f0f0f0',
        }}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
          />
          <Dropdown
            menu={{
              items: [{
                key: 'logout',
                icon: <LogoutOutlined />,
                label: '退出登录',
                onClick: logout,
              }],
            }}
          >
            <Space style={{ cursor: 'pointer' }}>
              <Avatar icon={<UserOutlined />} style={{ background: '#f093fb' }} />
              <Text>{user?.username}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>({user?.role})</Text>
            </Space>
          </Dropdown>
        </Header>
        <Content style={{ padding: 24, background: '#f5f5f5', overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
