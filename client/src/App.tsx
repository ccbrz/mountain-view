import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import MainLayout from './pages/MainLayout'
import PermissionManagement from './pages/PermissionManagement'
import FantasyWriter from './pages/FantasyWriter'
import NovelDetail from './pages/NovelDetail'
import ProtectedRoute from './components/ProtectedRoute'

function DefaultRedirect() {
  const { user } = useAuth()
  return <Navigate to={user?.role === 'admin' ? '/permissions' : '/fantasy'} replace />
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  if (user?.role !== 'admin') return <Navigate to="/fantasy" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><MainLayout /></ProtectedRoute>}>
          <Route index element={<DefaultRedirect />} />
          <Route path="permissions" element={<AdminGuard><PermissionManagement /></AdminGuard>} />
          <Route path="fantasy" element={<FantasyWriter />} />
          <Route path="novels/:id" element={<NovelDetail />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
