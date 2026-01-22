/**
 * 磁盘缓存实现
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export class DiskCache {
  private cacheDir: string

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir || path.join(
      process.env.HOME || process.env.USERPROFILE || __dirname,
      '.photo-proxy',
      'cache'
    )
    this.ensureCacheDir()
  }

  /**
   * 确保缓存目录存在
   */
  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true })
    }
  }

  /**
   * 生成缓存文件路径
   */
  private getCachePath(key: string): string {
    // 使用 assetId_size 作为文件名
    // 清理特殊字符，避免文件名问题
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_')
    return path.join(this.cacheDir, `${safeKey}.jpg`)
  }

  /**
   * 设置缓存
   */
  set(key: string, data: Buffer): void {
    try {
      const filePath = this.getCachePath(key)
      fs.writeFileSync(filePath, data)
    } catch (error) {
      console.error(`[DiskCache] Failed to write cache for ${key}:`, error)
    }
  }

  /**
   * 获取缓存
   */
  get(key: string): Buffer | null {
    try {
      const filePath = this.getCachePath(key)
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath)
      }
    } catch (error) {
      console.error(`[DiskCache] Failed to read cache for ${key}:`, error)
    }
    return null
  }

  /**
   * 删除缓存
   */
  delete(key: string): void {
    try {
      const filePath = this.getCachePath(key)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch (error) {
      console.error(`[DiskCache] Failed to delete cache for ${key}:`, error)
    }
  }

  /**
   * 清空缓存
   */
  clear(): void {
    try {
      if (fs.existsSync(this.cacheDir)) {
        const files = fs.readdirSync(this.cacheDir)
        for (const file of files) {
          fs.unlinkSync(path.join(this.cacheDir, file))
        }
      }
    } catch (error) {
      console.error(`[DiskCache] Failed to clear cache:`, error)
    }
  }
}
