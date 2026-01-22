/**
 * PhotosService 包装器
 * 
 * 使用 tsx 动态加载 TypeScript 模块
 * 这个文件是 CommonJS，可以在 Electron 中直接使用
 */

import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let PhotosService = null

export async function getPhotosService() {
  if (PhotosService) {
    return PhotosService
  }

  try {
    // 尝试使用 tsx 加载 TypeScript 文件
    // 如果 tsx loader 可用，直接导入 .ts 文件
    const servicePath = path.join(__dirname, 'service.ts')
    
    // 检查是否在支持 tsx 的环境中
    if (process.env.NODE_OPTIONS && process.env.NODE_OPTIONS.includes('tsx')) {
      const { PhotosService: Service } = await import(servicePath)
      PhotosService = Service
      return PhotosService
    } else {
      // 尝试直接导入（如果已经编译为 .js）
      const jsPath = path.join(__dirname, 'service.js')
      const { PhotosService: Service } = await import(jsPath)
      PhotosService = Service
      return PhotosService
    }
  } catch (error) {
    console.error('[service-wrapper] Failed to load PhotosService:', error)
    throw error
  }
}
