/**
 * 相册列表管理
 */

import type { Album } from '../types.js'
import { PhotosService } from '../usb/service.js'

export class AlbumsManager {
  private photosService: PhotosService

  constructor(photosService: PhotosService) {
    this.photosService = photosService
  }

  /**
   * 获取相册列表
   * 
   * Phase 1 实现：
   * - 返回系统相册（Camera Roll）
   * - 返回时间相册（按年月）
   * 
   * 后续可以扩展为从 Photos Service 获取实际相册
   */
  async getAlbums(): Promise<Album[]> {
    // Phase 1: 暂时返回空列表，表示 Photos Service 不可用
    // 前端会 fallback 到 PTP
    const available = await this.photosService.isAvailable()
    if (!available) {
      return []
    }

    // TODO: 实现从 Photos Service 获取相册列表
    // 这里应该返回类似：
    // [
    //   { id: "camera_roll", name: "所有照片", type: "system" },
    //   { id: "2025-03", name: "2025年3月", type: "time" },
    //   ...
    // ]
    return []
  }
}
