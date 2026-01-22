/**
 * Photo Proxy Types
 * 
 * 核心改变：使用 assetId 作为唯一索引，移除 folder/name
 */

export interface Asset {
  /**
   * iOS Photos 的 assetId（localIdentifier）
   * 格式：F4C8B9A1-2C3D-4E5F-ABCD-1234567890
   * 这是唯一索引，所有操作都基于它
   */
  assetId: string
  
  /**
   * 资源类型
   */
  type: 'image' | 'video'
  
  /**
   * 子类型（可选）
   */
  subtype?: ('live' | 'hdr' | 'slowmo' | 'panorama' | 'portrait')[]
  
  /**
   * 宽度（像素）
   */
  width: number
  
  /**
   * 高度（像素）
   */
  height: number
  
  /**
   * 视频时长（秒），仅视频有效
   */
  duration?: number
  
  /**
   * 创建时间（Unix 时间戳）
   */
  creationTime: number
}

export interface AssetListResponse {
  /**
   * 总数量
   */
  total: number
  
  /**
   * 当前页的资源列表
   */
  items: Asset[]
}

export interface ThumbnailOptions {
  assetId: string
  size?: number // 默认 320，单位：像素
}

export interface ImageOptions {
  assetId: string
  quality?: 'full' | 'screen' // full: 原图, screen: 屏幕尺寸
  format?: 'jpeg' | 'heic' // 输出格式
}

export interface VideoStreamOptions {
  assetId: string
  // Phase 1 不支持 seek
}

export interface Album {
  id: string
  name: string
  type: 'system' | 'time' | 'user'
}

export interface PhotoProxyConfig {
  port?: number
  cacheDir?: string
  memoryCacheTTL?: number // 内存缓存 TTL（毫秒）
}
