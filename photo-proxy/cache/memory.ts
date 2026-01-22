/**
 * 内存缓存实现
 */

interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number
}

export class MemoryCache {
  private cache: Map<string, CacheEntry<any>> = new Map()
  private defaultTTL: number

  constructor(defaultTTL: number = 10 * 60 * 1000) {
    // 默认 10 分钟
    this.defaultTTL = defaultTTL
  }

  /**
   * 设置缓存
   */
  set<T>(key: string, data: T, ttl?: number): void {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL
    }
    this.cache.set(key, entry)
  }

  /**
   * 获取缓存
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) {
      return null
    }

    // 检查是否过期
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return null
    }

    return entry.data as T
  }

  /**
   * 删除缓存
   */
  delete(key: string): void {
    this.cache.delete(key)
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * 清理过期缓存
   */
  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key)
      }
    }
  }
}
