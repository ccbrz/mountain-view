import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import MainLayout from './pages/MainLayout'
import PermissionManagement from './pages/PermissionManagement'
import Bookshelf from './pages/Bookshelf'
import NovelWorkspace from './pages/NovelWorkspace'
import ProtectedRoute from './components/ProtectedRoute'

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  if (user?.role !== 'admin') return <Navigate to="/books" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <MainLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/books" replace />} />
          <Route path="books" element={<Bookshelf />} />
          <Route
            path="permissions"
            element={
              <AdminGuard>
                <PermissionManagement />
              </AdminGuard>
            }
          />
        </Route>
        <Route
          path="/novels/:id"
          element={
            <ProtectedRoute>
              <NovelWorkspace />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/books" replace />} />
      </Routes>
    </AuthProvider>
  )
}
