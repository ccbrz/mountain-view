import { useState, useEffect } from 'react'
import {
  Layout, Table, Button, Modal, Form, Input, Select, Tag, message, Card, Space, Tabs,
} from 'antd'
import { PlusOutlined, UserAddOutlined } from '@ant-design/icons'
import api from '../api'

interface Role {
  id: number
  name: string
  description: string
  permissions: string[]
}

interface User {
  id: number
  username: string
  role: string
}

const permissionOptions = [
  { label: '用户管理', value: 'users:manage' },
  { label: '角色管理', value: 'roles:manage' },
  { label: '内容管理', value: 'content:manage' },
  { label: '系统设置', value: 'settings:manage' },
]

export default function PermissionManagement() {
  const [roles, setRoles] = useState<Role[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [roleModal, setRoleModal] = useState(false)
  const [userModal, setUserModal] = useState(false)
  const [editingRole, setEditingRole] = useState<Role | null>(null)
  const [roleForm] = Form.useForm()
  const [userForm] = Form.useForm()

  useEffect(() => {
    fetchRoles()
    fetchUsers()
  }, [])

  const fetchRoles = async () => {
    const res = await api.get('/roles')
    setRoles(res.data)
  }

  const fetchUsers = async () => {
    try {
      const res = await api.get('/roles/users')
      setUsers(res.data)
    } catch {
      // not admin
    }
  }

  const openCreateRole = () => {
    setEditingRole(null)
    roleForm.resetFields()
    setRoleModal(true)
  }

  const openEditRole = (role: Role) => {
    setEditingRole(role)
    roleForm.setFieldsValue(role)
    setRoleModal(true)
  }

  const handleSaveRole = async () => {
    const values = await roleForm.validateFields()
    if (editingRole) {
      await api.put(`/roles/${editingRole.id}`, values)
      message.success('角色已更新')
    } else {
      await api.post('/roles', values)
      message.success('角色已创建')
    }
    setRoleModal(false)
    fetchRoles()
  }

  const handleDeleteRole = (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除这个角色吗？',
      onOk: async () => {
        await api.delete(`/roles/${id}`)
        message.success('角色已删除')
        fetchRoles()
      },
    })
  }

  const handleRoleChange = async (userId: number, role: string) => {
    await api.put(`/roles/users/${userId}/role`, { role })
    message.success('用户角色已更新')
    fetchUsers()
  }

  const openAddUser = () => {
    userForm.resetFields()
    setUserModal(true)
  }

  const handleAddUser = async () => {
    const values = await userForm.validateFields()
    await api.post('/roles/users', values)
    message.success('用户已创建')
    setUserModal(false)
    fetchUsers()
  }

  const roleColumns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '描述', dataIndex: 'description', key: 'description' },
    {
      title: '权限', dataIndex: 'permissions', key: 'permissions',
      render: (perms: string[]) => (
        <Space>{perms.map((p) => <Tag key={p}>{p}</Tag>)}</Space>
      ),
    },
    {
      title: '操作', key: 'action',
      render: (_: unknown, record: Role) => (
        <Space>
          <Button type="link" onClick={() => openEditRole(record)}>编辑</Button>
          <Button type="link" danger onClick={() => handleDeleteRole(record.id)}>删除</Button>
        </Space>
      ),
    },
  ]

  const userColumns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 80 },
    { title: '用户名', dataIndex: 'username', key: 'username' },
    {
      title: '角色', dataIndex: 'role', key: 'role',
      render: (role: string, record: User) => (
        <Select
          value={role}
          onChange={(v) => handleRoleChange(record.id, v)}
          style={{ width: 120 }}
        >
          {roles.map((r) => (
            <Select.Option key={r.name} value={r.name}>{r.name}</Select.Option>
          ))}
        </Select>
      ),
    },
  ]

  const tabItems = [
    {
      key: 'roles',
      label: '角色管理',
      children: (
        <Table
          dataSource={roles}
          columns={roleColumns}
          rowKey="id"
          pagination={false}
        />
      ),
    },
    {
      key: 'users',
      label: `用户管理 (${users.length})`,
      children: (
        <Table
          dataSource={users}
          columns={userColumns}
          rowKey="id"
          pagination={false}
        />
      ),
    },
  ]

  return (
    <>
      <Card
        title="权限管理"
        extra={
          <Space>
            <Button icon={<UserAddOutlined />} onClick={openAddUser}>添加用户</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateRole}>新建角色</Button>
          </Space>
        }
      >
        <Tabs items={tabItems} />
      </Card>

      <Modal
        title={editingRole ? '编辑角色' : '新建角色'}
        open={roleModal}
        onOk={handleSaveRole}
        onCancel={() => setRoleModal(false)}
      >
        <Form form={roleForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入角色名称' }]}>
            <Input disabled={!!editingRole} placeholder="角色名称" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea placeholder="角色描述" />
          </Form.Item>
          <Form.Item name="permissions" label="权限">
            <Select mode="multiple" placeholder="选择权限" options={permissionOptions} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="添加用户"
        open={userModal}
        onOk={handleAddUser}
        onCancel={() => setUserModal(false)}
      >
        <Form form={userForm} layout="vertical">
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="用户名" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="密码" />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="user">
            <Select>
              {roles.map((r) => (
                <Select.Option key={r.name} value={r.name}>{r.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
