import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { LoginPage } from './pages/Login'
import { MembersPage } from './pages/Members'
import { RoomPage } from './pages/Room'
import { RoomsPage } from './pages/Rooms'
import { SettingsPage } from './pages/Settings'
import { UsagePage } from './pages/Usage'
import { SessionProvider, useSession } from './state/session'
import { ToastProvider } from './state/toast'
import './styles.css'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useSession()
  if (loading) return <div className="center-fill">加载中…</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth><Layout /></RequireAuth>}>
              <Route path="/rooms" element={<RoomsPage />} />
              <Route path="/rooms/:id" element={<RoomPage />} />
              <Route path="/members" element={<MembersPage />} />
              <Route path="/usage" element={<UsagePage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/rooms" replace />} />
          </Routes>
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
)
