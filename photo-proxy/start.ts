/**
 * Photo Proxy 服务启动脚本
 * 使用 tsx 直接运行此文件来启动服务
 */

import { PhotoProxyServer } from './server.js'
import path from 'node:path'
import os from 'node:os'

const cacheDir = process.env.CACHE_DIR || path.join(os.homedir(), '.photo-proxy', 'cache')

const server = new PhotoProxyServer({
  port: 9001,
  cacheDir,
  memoryCacheTTL: 10 * 60 * 1000
})

console.log('[PhotoProxy] Starting server...')
console.log('[PhotoProxy] Cache directory:', cacheDir)

server.start().catch((error) => {
  console.error('[PhotoProxy] Failed to start:', error)
  if (error.code === 'EADDRINUSE') {
    console.error('\n💡 提示：端口被占用，请先停止占用端口的进程')
    console.error('   运行: lsof -ti:9001 | xargs kill -9')
  }
  process.exit(1)
})

// 处理退出信号
process.on('SIGTERM', () => {
  console.log('[PhotoProxy] Received SIGTERM, shutting down...')
  server.stop().then(() => {
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('[PhotoProxy] Received SIGINT, shutting down...')
  server.stop().then(() => {
    process.exit(0)
  })
})
