/**
 * 缩略图管理（核心功能）
 */

import type { ThumbnailOptions } from '../types.js'
import { PhotosService } from '../usb/service.js'
import { MemoryCache } from '../cache/memory.js'
import { DiskCache } from '../cache/disk.js'

export class ThumbnailManager {
  private photosService: PhotosService
  private memoryCache: MemoryCache
  private diskCache: DiskCache

  constructor(photosService: PhotosService, memoryCache: MemoryCache, diskCache: DiskCache) {
    this.photosService = photosService
    this.memoryCache = memoryCache
    this.diskCache = diskCache
  }

  /**
   * 获取缩略图
   * 
   * Phase 1 实现策略：
   * 1. 检查内存缓存
   * 2. 检查磁盘缓存
   * 3. 从 Photos Service 获取
   * 4. 缓存结果
   */
  async getThumbnail(options: ThumbnailOptions): Promise<Buffer | null> {
    const { assetId, size = 320 } = options
    const cacheKey = `${assetId}_${size}`

    // 1. 检查内存缓存
    const memoryCached = this.memoryCache.get<Buffer>(cacheKey)
    if (memoryCached) {
      console.log(`[ThumbnailManager] Memory cache hit: ${cacheKey}`)
      return memoryCached
    }

    // 2. 检查磁盘缓存
    const diskCached = this.diskCache.get(cacheKey)
    if (diskCached) {
      console.log(`[ThumbnailManager] Disk cache hit: ${cacheKey}`)
      // 同时更新内存缓存
      this.memoryCache.set(cacheKey, diskCached)
      return diskCached
    }

    // 3. 从 Photos Service 获取
    const available = await this.photosService.isAvailable()
    if (!available) {
      return null
    }

    // TODO: 实现从 Photos Service 获取缩略图
    // 这里应该：
    // 1. 通过 Photos Service 协议请求缩略图
    // 2. 指定尺寸（size）
    // 3. 返回 JPEG 数据
    const thumbnailData = await this.fetchThumbnailFromService(assetId, size)
    if (!thumbnailData) {
      return null
    }

    // 4. 缓存结果
    this.memoryCache.set(cacheKey, thumbnailData)
    this.diskCache.set(cacheKey, thumbnailData)

    return thumbnailData
  }

  /**
   * 从 Photos Service 获取缩略图
   */
  private async fetchThumbnailFromService(assetId: string, size: number): Promise<Buffer | null> {
    console.log(`[ThumbnailManager] fetchThumbnailFromService: assetId=${assetId}, size=${size}`)
    
    try {
      // 通过 Bridge Service 获取缩略图
      const thumbnail = await this.photosService.getThumbnail(assetId, size)
      
      // 验证大小（≤ 30KB）
      if (thumbnail.length > 30 * 1024) {
        console.warn(`[ThumbnailManager] ⚠️ Thumbnail too large: ${thumbnail.length} bytes, expected ≤ 30KB`)
      }
      
      console.log(`[ThumbnailManager] ✅ Got thumbnail: ${thumbnail.length} bytes`)
      return thumbnail
    } catch (error) {
      console.error(`[ThumbnailManager] ❌ Failed to get thumbnail:`, error)
      return null
    }
  }
}
