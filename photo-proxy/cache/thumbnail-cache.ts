/**
 * PC 端 Thumbnail Cache
 * 
 * 基于爱思助手级别的真实实现
 * 
 * 缓存分层：
 * L0: 内存 Cache (LRU)
 * L1: 磁盘 Cache (~/.photo-tool/cache/thumb/)
 * 
 * LRU 2000 张
 * 手机断开仍可显示灰图
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'crypto'

interface CacheEntry {
  data: Buffer
  timestamp: number
  size: number
}

export class ThumbnailCache {
  private memoryCache: Map<string, CacheEntry> = new Map()
  private maxMemoryEntries: number = 200
  private maxDiskEntries: number = 2000
  private cacheDir: string

  constructor() {
    // 缓存目录：~/.photo-tool/cache/thumb/
    const homeDir = os.homedir()
    this.cacheDir = path.join(homeDir, '.photo-tool', 'cache', 'thumb')
    
    // 确保缓存目录存在
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true })
    }
    
    // 清理旧缓存（启动时）
    this.cleanupOldCache()
  }

  /**
   * 获取缓存键
   */
  private getCacheKey(assetId: string, size: number): string {
    // 使用 assetId 和 size 生成缓存键
    const hash = createHash('md5').update(`${assetId}:${size}`).digest('hex')
    return hash
  }

  /**
   * 获取文件路径
   */
  private getCachePath(assetId: string, size: number): string {
    const key = this.getCacheKey(assetId, size)
    return path.join(this.cacheDir, `${key}.jpg`)
  }

  /**
   * 获取缩略图（先查内存，再查磁盘）
   */
  async get(assetId: string, size: number): Promise<Buffer | null> {
    const key = this.getCacheKey(assetId, size)
    
    // 1. 检查内存缓存
    const memoryEntry = this.memoryCache.get(key)
    if (memoryEntry) {
      console.log(`[ThumbnailCache] ✅ Memory cache hit: ${assetId}`)
      return memoryEntry.data
    }
    
    // 2. 检查磁盘缓存
    const cachePath = this.getCachePath(assetId, size)
    if (fs.existsSync(cachePath)) {
      try {
        const data = fs.readFileSync(cachePath)
        console.log(`[ThumbnailCache] ✅ Disk cache hit: ${assetId}`)
        
        // 存入内存缓存
        this.setMemoryCache(key, data)
        
        return data
      } catch (error) {
        console.warn(`[ThumbnailCache] Failed to read cache file:`, error)
      }
    }
    
    return null
  }

  /**
   * 设置缓存（同时写入内存和磁盘）
   */
  async set(assetId: string, size: number, data: Buffer): Promise<void> {
    const key = this.getCacheKey(assetId, size)
    
    // 1. 存入内存缓存
    this.setMemoryCache(key, data)
    
    // 2. 写入磁盘缓存
    const cachePath = this.getCachePath(assetId, size)
    try {
      fs.writeFileSync(cachePath, data)
      console.log(`[ThumbnailCache] ✅ Cached: ${assetId} (${data.length} bytes)`)
    } catch (error) {
      console.warn(`[ThumbnailCache] Failed to write cache file:`, error)
    }
  }

  /**
   * 设置内存缓存（LRU）
   */
  private setMemoryCache(key: string, data: Buffer): void {
    // 如果超过限制，删除最旧的条目
    if (this.memoryCache.size >= this.maxMemoryEntries) {
      // 找到最旧的条目
      let oldestKey: string | null = null
      let oldestTime = Date.now()
      
      for (const [k, entry] of this.memoryCache.entries()) {
        if (entry.timestamp < oldestTime) {
          oldestTime = entry.timestamp
          oldestKey = k
        }
      }
      
      if (oldestKey) {
        this.memoryCache.delete(oldestKey)
      }
    }
    
    this.memoryCache.set(key, {
      data,
      timestamp: Date.now(),
      size: data.length
    })
  }

  /**
   * 清理旧缓存
   */
  private cleanupOldCache(): void {
    try {
      const files = fs.readdirSync(this.cacheDir)
      const entries: Array<{ path: string; mtime: number }> = []
      
      for (const file of files) {
        if (file.endsWith('.jpg')) {
          const filePath = path.join(this.cacheDir, file)
          const stats = fs.statSync(filePath)
          entries.push({ path: filePath, mtime: stats.mtimeMs })
        }
      }
      
      // 按修改时间排序，删除最旧的
      entries.sort((a, b) => a.mtime - b.mtime)
      
      if (entries.length > this.maxDiskEntries) {
        const toDelete = entries.slice(0, entries.length - this.maxDiskEntries)
        for (const entry of toDelete) {
          fs.unlinkSync(entry.path)
        }
        console.log(`[ThumbnailCache] Cleaned up ${toDelete.length} old cache files`)
      }
    } catch (error) {
      console.warn(`[ThumbnailCache] Failed to cleanup cache:`, error)
    }
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.memoryCache.clear()
    
    try {
      const files = fs.readdirSync(this.cacheDir)
      for (const file of files) {
        if (file.endsWith('.jpg')) {
          fs.unlinkSync(path.join(this.cacheDir, file))
        }
      }
    } catch (error) {
      console.warn(`[ThumbnailCache] Failed to clear cache:`, error)
    }
  }
}
