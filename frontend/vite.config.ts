import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 后端（ChatGPT 负责）默认跑在 8000 端口
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
})
