import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// /api 代理到 Nest（音频与 SSE 同源），避免跨域；保持单一本机入口。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.RADIO_API_TARGET || 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
})
