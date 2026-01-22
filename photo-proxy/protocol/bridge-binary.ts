/**
 * PC Bridge Service - 二进制协议 over usbmuxd
 * 
 * 基于爱思助手级别的真实实现
 * 使用二进制帧格式，不使用 HTTP
 */

import { FrameSerializer, FrameType, type Frame } from './frame.js'
import type { IOSDevice } from '../usb/device.js'
import { Readable } from 'stream'
import { ThumbnailCache } from '../cache/thumbnail-cache.js'
import { UsbmuxdClient } from '../usb/usbmuxd.js'

export interface ListAssetsRequest {
  limit: number
  offset: number
}

export interface ListAssetsResponse {
  total: number
  items: Array<{
    assetId: string
    type: 'image' | 'video'
    width: number
    height: number
    creationTime?: number
  }>
}

export interface GetThumbRequest {
  assetId: string
  size: number
}

export class BridgeServiceBinary {
  private serviceSocket: any = null // usbmuxd 返回的 Duplex stream
  private device: IOSDevice | null = null
  private connected: boolean = false
  private requestIdCounter: number = 0
  private pendingRequests: Map<number, {
    resolve: (value: any) => void
    reject: (error: Error) => void
    stream?: Readable
    data?: Buffer // 用于累积非流式数据
  }> = new Map()
  private usbmuxd: UsbmuxdClient | null = null
  private servicePort: number = 12345
  private receiveBuffer: Buffer = Buffer.alloc(0)
  private thumbnailCache: ThumbnailCache = new ThumbnailCache()

  /**
   * 连接到 iOS Companion Service（直接通过 usbmuxd）
   * 
   * 根据验证：usbmuxd 可以直接连接到用户 App 打开的端口
   * 前提条件：
   * 1. App 必须在前台运行（或使用保活机制）
   * 2. 使用 Developer 通道（Xcode 连接或 DeveloperDiskImage 已挂载）
   * 3. 使用正确的端口监听方式（NWListener）
   */
  async connect(device: IOSDevice): Promise<void> {
    if (this.connected && this.device?.udid === device.udid) {
      return // 已经连接到同一设备
    }

    await this.disconnect()

    this.device = device
    const udid = device.udid

    console.log(`[BridgeServiceBinary] Connecting to device: ${udid} on port ${this.servicePort} via usbmuxd`)
    console.log(`[BridgeServiceBinary]`)
    console.log(`[BridgeServiceBinary] ⚠️  IMPORTANT PREREQUISITES:`)
    console.log(`[BridgeServiceBinary]   1. iOS Companion Service app MUST be running in FOREGROUND`)
    console.log(`[BridgeServiceBinary]      → Open the app on device and keep it in foreground`)
    console.log(`[BridgeServiceBinary]   2. iOS Tunnel MUST be running (iOS 17+ required)`)
    console.log(`[BridgeServiceBinary]      → Run: ./commands/ios tunnel start --userspace --udid=${udid}`)
    console.log(`[BridgeServiceBinary]      → Or: yarn mount:ddi ${udid} (auto-starts tunnel)`)
    console.log(`[BridgeServiceBinary]   3. Developer Disk Image MUST be mounted`)
    console.log(`[BridgeServiceBinary]      → Connect device to Xcode (auto-mounts DDI)`)
    console.log(`[BridgeServiceBinary]      → Or enable Developer Mode in Settings > Privacy & Security`)
    console.log(`[BridgeServiceBinary]      → Or run: yarn mount:ddi ${udid}`)
    console.log(`[BridgeServiceBinary]   4. App must be listening on port ${this.servicePort}`)
    console.log(`[BridgeServiceBinary]      → Check Xcode console for "Listener ready on port: 12345"`)
    console.log(`[BridgeServiceBinary]`)

    try {
      // 1. 连接到 usbmuxd
      this.usbmuxd = new UsbmuxdClient()
      await this.usbmuxd.connect()
      console.log('[BridgeServiceBinary] ✅ Connected to usbmuxd')

      // 2. 直接连接到设备上的端口（usbmuxd 会处理端口字节序转换）
      // 注意：端口 12345 会被转换为大端序：htons(12345) = 0x3930 = 14640
      // 
      // 如果连接失败（错误码 1），最常见的原因是：
      // - Developer Disk Image 未挂载（即使应用在运行，usbmuxd 也无法访问用户应用端口）
      // - App 不在前台（iOS 会挂起后台应用的网络连接）
      // 
      // 验证步骤：
      // 1. 在 Xcode 中运行应用，确保在前台
      // 2. 检查 Xcode 控制台是否有 "Listener ready" 日志
      // 3. 确保 Xcode 已连接设备（自动挂载 Developer Disk Image）
      console.log(`[BridgeServiceBinary] Attempting to connect to device port ${this.servicePort}...`)
      const portBigEndian = ((this.servicePort & 0xFF) << 8) | ((this.servicePort >> 8) & 0xFF)
      console.log(`[BridgeServiceBinary] Port conversion: ${this.servicePort} (0x${this.servicePort.toString(16)}) -> ${portBigEndian} (0x${portBigEndian.toString(16)})`)
      
      this.serviceSocket = await this.usbmuxd.connectToDevice(udid, this.servicePort)
      console.log(`[BridgeServiceBinary] ✅ Connected to device port ${this.servicePort}`)

      // 3. 设置消息处理器
      this.setupMessageHandler()
      
      this.connected = true
      console.log('[BridgeServiceBinary] ✅ Connected to iOS Companion Service')
      console.log('[BridgeServiceBinary] Ready to send/receive binary frames')
    } catch (error: any) {
      console.error('[BridgeServiceBinary] ❌ Connection failed:', error)
      console.error('[BridgeServiceBinary]')
      console.error('[BridgeServiceBinary] ===== TROUBLESHOOTING GUIDE =====')
      console.error('[BridgeServiceBinary]')
      console.error('[BridgeServiceBinary] Step 1: Check if app is running')
      console.error(`[BridgeServiceBinary]   - Open iOS Companion Service app on device`)
      console.error(`[BridgeServiceBinary]   - Ensure app is in FOREGROUND (not backgrounded)`)
      console.error(`[BridgeServiceBinary]   - Check Xcode console for "Listener ready on port: 12345"`)
      console.error('[BridgeServiceBinary]')
      console.error('[BridgeServiceBinary] Step 2: Check Developer mode')
      console.error(`[BridgeServiceBinary]   - Run: ideviceinfo -u ${udid} | grep Developer`)
      console.error(`[BridgeServiceBinary]   - Or: Ensure Xcode is connected to device`)
      console.error(`[BridgeServiceBinary]   - Developer Disk Image must be mounted`)
      console.error('[BridgeServiceBinary]')
      console.error('[BridgeServiceBinary] Step 3: Verify port listening')
      console.error(`[BridgeServiceBinary]   - Check Xcode console for connection logs`)
      console.error(`[BridgeServiceBinary]   - Look for "New connection received from PC via usbmuxd"`)
      console.error('[BridgeServiceBinary]')
      console.error('[BridgeServiceBinary] Common issues:')
      console.error('[BridgeServiceBinary]   - iOS Tunnel not running (iOS 17+ required)')
      console.error('[BridgeServiceBinary]   - App in background → iOS suspends network connections')
      console.error('[BridgeServiceBinary]   - No Developer Disk Image → usbmuxd cannot access user app ports')
      console.error('[BridgeServiceBinary]   - Port not listening → Check Xcode console for errors')
      console.error('[BridgeServiceBinary]')
      console.error('[BridgeServiceBinary] SOLUTION (iOS 17+):')
      console.error(`[BridgeServiceBinary]   1. Start iOS tunnel: ./commands/ios tunnel start --userspace --udid=${udid}`)
      console.error(`[BridgeServiceBinary]   2. Mount DDI: yarn mount:ddi ${udid}`)
      console.error('[BridgeServiceBinary]')
      console.error('[BridgeServiceBinary] OR (Alternative):')
      console.error('[BridgeServiceBinary]   - Enable Developer Mode in device Settings > Privacy & Security')
      console.error('[BridgeServiceBinary]   - Connect device to Xcode and wait for auto-mount')
      console.error('[BridgeServiceBinary] =================================')
      await this.disconnect()
      throw error
    }
  }


  /**
   * 设置消息处理器
   */
  private setupMessageHandler(): void {
    if (!this.serviceSocket) return

    this.receiveBuffer = Buffer.alloc(0)

    this.serviceSocket.on('data', (data: Buffer) => {
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, data])
      this.processFrames()
    })

    this.serviceSocket.on('error', (error: Error) => {
      console.error('[BridgeServiceBinary] Socket error:', error)
      // 清理所有待处理的请求
      for (const [id, pending] of this.pendingRequests.entries()) {
        pending.reject(error)
      }
      this.pendingRequests.clear()
    })

    this.serviceSocket.on('close', () => {
      console.log('[BridgeServiceBinary] Socket closed')
      this.connected = false
    })
  }

  /**
   * 处理接收到的帧
   */
  private processFrames(): void {
    while (true) {
      const { frame, remaining } = FrameSerializer.extractFrame(this.receiveBuffer)
      
      if (!frame) {
        // 帧不完整，等待更多数据
        break
      }

      this.receiveBuffer = remaining
      this.handleFrame(frame)
    }
  }

  /**
   * 处理帧
   */
  private handleFrame(frame: Frame): void {
    const { header, payload } = frame
    const { type, requestId } = header

    console.log(`[BridgeServiceBinary] Received frame: type=${type}, requestId=${requestId}, payloadLen=${payload.length}`)

    const pending = this.pendingRequests.get(requestId)
    if (!pending) {
      console.warn(`[BridgeServiceBinary] Received frame for unknown requestId: ${requestId}`)
      return
    }

    if (type === FrameType.DATA) {
      // 数据帧（用于缩略图、图片、视频）
      if (pending.stream) {
        // 流式响应（图片、视频）
        if (payload.length === 0) {
          // 空 payload 表示流结束
          pending.stream.push(null)
          this.pendingRequests.delete(requestId)
        } else {
          pending.stream.push(payload)
        }
      } else {
        // 非流式响应（缩略图），单个 DATA 帧包含完整 JPEG
        // 对于 GET_THUMB，响应是单个 DATA 帧
        pending.resolve(payload)
        this.pendingRequests.delete(requestId)
      }
    } else if (type === FrameType.ERROR) {
      // 错误帧
      const errorMsg = payload.toString('utf-8')
      console.error(`[BridgeServiceBinary] Error for requestId ${requestId}: ${errorMsg}`)
      pending.reject(new Error(errorMsg))
      this.pendingRequests.delete(requestId)
    } else {
      // 其他类型的响应帧（如 LIST_ASSETS 的 JSON 响应）
      try {
        const json = JSON.parse(payload.toString('utf-8'))
        // LIST_ASSETS 等请求的响应是 JSON，直接解析
        pending.resolve(json)
        this.pendingRequests.delete(requestId)
      } catch (error) {
        console.error(`[BridgeServiceBinary] Failed to parse JSON response:`, error)
        pending.reject(new Error('Invalid JSON response'))
        this.pendingRequests.delete(requestId)
      }
    }
  }

  /**
   * 发送请求并等待响应
   */
  private async sendRequest(type: FrameType, payload: any, expectStream: boolean = false): Promise<any> {
    if (!this.connected || !this.serviceSocket) {
      throw new Error('Not connected to iOS Companion Service')
    }

    const requestId = ++this.requestIdCounter
    const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf-8')
    const frame = FrameSerializer.serialize(type, requestId, payloadBuffer)

    console.log(`[BridgeServiceBinary] Sending frame: type=${type}, requestId=${requestId}, size=${frame.length} bytes`)

    return new Promise((resolve, reject) => {
      if (expectStream) {
        const stream = new Readable({
          read() {
            // 数据通过 handleFrame 推送
          }
        })
        this.pendingRequests.set(requestId, { resolve, reject, stream })
        resolve(stream)
      } else {
        this.pendingRequests.set(requestId, { resolve, reject })
      }

      // 添加超时处理
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`Request timeout for requestId ${requestId}`))
      }, 30000) // 30 秒超时

      // 更新 pending request，添加超时清理
      const pending = this.pendingRequests.get(requestId)
      if (pending) {
        const originalReject = pending.reject
        pending.reject = (error: Error) => {
          clearTimeout(timeout)
          originalReject(error)
        }
        const originalResolve = pending.resolve
        pending.resolve = (value: any) => {
          clearTimeout(timeout)
          originalResolve(value)
        }
      }

      this.serviceSocket!.write(frame, (error: Error | undefined) => {
        if (error) {
          clearTimeout(timeout)
          this.pendingRequests.delete(requestId)
          console.error(`[BridgeServiceBinary] Failed to send frame:`, error)
          reject(error)
        } else {
          console.log(`[BridgeServiceBinary] Frame sent successfully`)
        }
      })
    })
  }

  /**
   * 获取资源列表
   */
  async listAssets(limit: number, offset: number): Promise<ListAssetsResponse> {
    return this.sendRequest(FrameType.LIST_ASSETS, { limit, offset })
  }

  /**
   * 获取缩略图（返回 JPEG Buffer）
   * 
   * 缓存策略：
   * 1. 先查本地缓存（内存 + 磁盘）
   * 2. 如果未命中，从 iOS 获取
   * 3. 存入缓存
   * 
   * GET_THUMB 响应：单个 DATA 帧包含完整 JPEG
   */
  async getThumbnail(assetId: string, size: number): Promise<Buffer> {
    // 1. 检查缓存
    const cached = await this.thumbnailCache.get(assetId, size)
    if (cached) {
      return cached
    }
    
    // 2. 从 iOS 获取（GET_THUMB 返回单个 DATA 帧）
    const response = await this.sendRequest(FrameType.GET_THUMB, { assetId, size }, false)
    
    // response 应该是 Buffer（DATA 帧的 payload）
    const thumbnailData = Buffer.isBuffer(response) ? response : Buffer.alloc(0)
    
    // 3. 存入缓存
    if (thumbnailData.length > 0) {
      await this.thumbnailCache.set(assetId, size, thumbnailData)
    }
    
    return thumbnailData
  }

  /**
   * 获取图片（流式）
   */
  async getImage(assetId: string, quality: 'full' | 'screen' = 'full'): Promise<Readable> {
    return this.sendRequest(FrameType.GET_IMAGE, { assetId, quality }, true)
  }

  /**
   * 获取视频流（流式）
   */
  async getVideoStream(assetId: string): Promise<Readable> {
    return this.sendRequest(FrameType.GET_VIDEO, { assetId }, true)
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.serviceSocket) {
      this.serviceSocket.destroy()
      this.serviceSocket = null
    }

    if (this.usbmuxd) {
      this.usbmuxd.disconnect()
      this.usbmuxd = null
    }

    // 清理所有待处理的请求
    for (const [id, pending] of this.pendingRequests.entries()) {
      pending.reject(new Error('Disconnected'))
    }
    this.pendingRequests.clear()

    this.connected = false
    this.device = null
    this.receiveBuffer = Buffer.alloc(0)
    console.log('[BridgeServiceBinary] Disconnected')
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.connected
  }
}
