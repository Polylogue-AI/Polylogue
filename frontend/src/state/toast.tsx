import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

const Ctx = createContext<(msg: string) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const [key, setKey] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const toast = useCallback((m: string) => {
    setMsg(m); setKey((k) => k + 1)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setMsg(null), 2400)
  }, [])
  return (
    <Ctx.Provider value={toast}>
      {children}
      {msg && <div key={key} className="toast" role="status">{msg}</div>}
    </Ctx.Provider>
  )
}
export const useToast = () => useContext(Ctx)
