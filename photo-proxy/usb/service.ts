/**
 * Photos Service 连接管理
 * 
 * 实现路径：
 * 1. 通过 usbmuxd 建立连接
 * 2. 通过 lockdownd 启动 Photos Service
 * 3. 实现 Photos Service 的二进制协议
 * 
 * 当前状态：框架已创建，等待实现
 * 参考：IMPLEMENTATION_PLAN.md
 */

import type { IOSDevice } from './device.js'
import { BridgeServicePortForward } from '../protocol/bridge-port-forward.js'
import { setupIOSEnvironment } from './ios-setup.js'

export class PhotosService {
  private device: IOSDevice | null = null
  private bridgeService: BridgeServicePortForward | null = null
  private connected: boolean = false

  constructor() {
    // 使用端口转发方案（go-ios forward）
    // 因为 iOS 系统不允许 usbmuxd 直接访问用户应用端口
    // 端口转发方案已验证可行
    this.bridgeService = new BridgeServicePortForward()
  }

  /**
   * 设置目标设备
   */
  setDevice(device: IOSDevice): void {
    this.device = device
  }

  /**
   * 获取设备 UDID
   */
  private getDeviceUDID(): string {
    if (!this.device) {
      throw new Error('No device set')
    }
    return this.device.udid
  }

  /**
   * 连接到 Photos Service
   * 
   * 流程（端口转发方案）：
   * 1. 自动启动 iOS 隧道（如果需要）
   * 2. 自动挂载 Developer Disk Image（如果需要）
   * 3. 通过 go-ios forward 建立端口转发
   * 4. 连接到本地转发端口
   */
  async connect(): Promise<boolean> {
    try {
      if (this.connected) {
        return true
      }

      if (!this.device) {
        throw new Error('No device set')
      }

      const udid = this.getDeviceUDID()
      console.log(`[PhotosService] Connecting to device: ${udid}`)

      // 1. 自动设置 iOS 环境（启动隧道和挂载 DDI）
      console.log(`[PhotosService] Setting up iOS environment...`)
      const setupResult = await setupIOSEnvironment(udid)
      
      if (!setupResult.tunnel) {
        console.warn(`[PhotosService] ⚠️  iOS tunnel setup had issues, but continuing...`)
      }
      
      if (!setupResult.ddi) {
        console.warn(`[PhotosService] ⚠️  Developer Disk Image mount had issues, but continuing...`)
        console.warn(`[PhotosService]    If connection fails, try: yarn mount:ddi ${udid}`)
      }

      // 2. 通过 Bridge Service 连接
      console.log(`[PhotosService] Connecting to iOS Companion Service...`)
      await this.bridgeService!.connect(this.device)
      this.connected = this.bridgeService!.isConnected()
      
      if (this.connected) {
        console.log('[PhotosService] ✅ Connected to iOS Companion Service')
      } else {
        throw new Error('Connection failed')
      }

      return this.connected
    } catch (error) {
      console.error('[PhotosService] ❌ Connection failed:', error)
      await this.disconnect()
      return false
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.bridgeService) {
      await this.bridgeService.disconnect()
    }
    this.connected = false
    console.log('[PhotosService] Disconnected')
  }

  /**
   * 检查服务是否可用
   */
  async isAvailable(): Promise<boolean> {
    // 检查 Bridge Service 是否已连接
    if (this.bridgeService) {
      return this.bridgeService.isConnected()
    }
    return false
  }

  /**
   * 确保连接有效
   */
  private async ensureConnected(): Promise<void> {
    if (!this.device) {
      throw new Error('No device set')
    }
    
    // 检查连接状态
    const isConnected = this.bridgeService?.isConnected() ?? false
    
    if (!isConnected || !this.connected) {
      console.log('[PhotosService] Connection lost, attempting to reconnect...')
      await this.connect()
    }
  }

  /**
   * 获取所有资源列表（通过 Bridge Service）
   */
  async getAllAssets(limit: number, offset: number): Promise<{ total: number; items: any[] }> {
    await this.ensureConnected()
    
    if (!this.connected || !this.bridgeService) {
      throw new Error('Not connected to iOS Companion Service')
    }
    return this.bridgeService.listAssets(limit, offset)
  }

  /**
   * 获取缩略图（通过 Bridge Service）
   */
  async getThumbnail(assetId: string, size: number): Promise<Buffer> {
    await this.ensureConnected()
    
    if (!this.connected || !this.bridgeService) {
      throw new Error('Not connected to iOS Companion Service')
    }
    return this.bridgeService.getThumbnail(assetId, size)
  }

  /**
   * 获取原图（流式，通过 Bridge Service）
   */
  async getImage(assetId: string, quality: 'full' | 'screen' = 'full', format: 'jpeg' | 'heic' = 'jpeg'): Promise<NodeJS.ReadableStream> {
    await this.ensureConnected()
    
    if (!this.connected || !this.bridgeService) {
      throw new Error('Not connected to iOS Companion Service')
    }
    // bridge-binary 的 getImage 只接受 assetId 和 quality，format 参数暂不支持
    return this.bridgeService.getImage(assetId, quality)
  }

  /**
   * 获取视频流（通过 Bridge Service）
   */
  async getVideoStream(assetId: string): Promise<NodeJS.ReadableStream> {
    await this.ensureConnected()
    
    if (!this.connected || !this.bridgeService) {
      throw new Error('Not connected to iOS Companion Service')
    }
    return this.bridgeService.getVideoStream(assetId)
  }
}
