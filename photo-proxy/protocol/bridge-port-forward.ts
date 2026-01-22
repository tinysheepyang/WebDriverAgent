/**
 * PC Bridge Service - 端口转发方案
 * 
 * 由于 iOS 应用无法通过 lockdownd 注册服务，我们使用端口转发方案：
 * 1. iOS 应用监听固定端口（12345）
 * 2. PC 端通过 go-ios forward 建立端口转发
 * 3. PC 端连接到本地转发端口
 */

import { Socket } from 'net'
import { FrameSerializer, FrameType, type Frame } from './frame.js'
import type { IOSDevice } from '../usb/device.js'
import { Readable } from 'stream'
import { spawn } from 'child_process'
import path from 'node:path'

/**
 * 获取 go-ios 命令路径
 * 优先使用环境变量 IOS_COMMAND_PATH，否则使用 global.electronApp 或后备方案
 */
function getIOSCommandPath(): string {
  // 1. 优先使用环境变量（主进程已设置）
  if (process.env.IOS_COMMAND_PATH) {
    return process.env.IOS_COMMAND_PATH
  }
  // 2. 使用 global.electronApp（主进程已设置）
  if (typeof global !== 'undefined' && (global as any).electronApp) {
    const app = (global as any).electronApp
    const appPath = app.getAppPath()
    const isPackaged = app.isPackaged
    if (isPackaged) {
      if (process.resourcesPath) {
        return path.join(process.resourcesPath, 'commands', 'ios')
      } else {
        const resourcesDir = path.join(path.dirname(appPath), '..', 'Resources')
        return path.join(resourcesDir, 'commands', 'ios')
      }
    } else {
      return path.join(appPath, 'commands', 'ios')
    }
  }
  // 3. 后备方案：使用相对路径
  return process.platform === 'win32' ? 'ios.exe' : './commands/ios'
}

export class BridgeServicePortForward {
  private serviceSocket: Socket | null = null
  private device: IOSDevice | null = null
  private connected: boolean = false
  private requestIdCounter: number = 0
  private pendingRequests: Map<number, {
    resolve: (value: any) => void
    reject: (error: Error) => void
    stream?: Readable
    data?: Buffer // 用于累积非流式数据
  }> = new Map()
  private forwardProcess: any = null
  private forwardPort: number = 12345
  private receiveBuffer: Buffer = Buffer.alloc(0)

  /**
   * 清理可能存在的旧端口转发进程
   */
  private async cleanupExistingPortForward(): Promise<void> {
    try {
      // 检查端口是否被占用
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(exec)
      
      try {
        // 只清理 go-ios forward 监听的进程，避免误杀 Electron / Vite 等本地进程
        const { stdout } = await execAsync(`lsof -ti :${this.forwardPort}`)
        const pids = stdout.trim().split('\n').filter(Boolean)
        if (pids.length > 0) {
          console.log(`[BridgeServicePortForward] Found existing processes on port ${this.forwardPort}: ${pids.join(', ')}`)
          // 仅杀掉命令包含 "ios forward <port>" 的进程
          for (const pid of pids) {
            try {
              const { stdout: cmdline } = await execAsync(`ps -o command= -p ${pid}`)
              const cmd = cmdline.trim()
              const isGoIOSForward = /ios(.exe)?\s+forward\s+12345/.test(cmd)
              if (isGoIOSForward) {
                await execAsync(`kill -9 ${pid}`)
                console.log(`[BridgeServicePortForward] Killed go-ios forward process ${pid}`)
              } else {
                console.log(`[BridgeServicePortForward] Skip killing non go-ios process ${pid}: ${cmd}`)
              }
            } catch (error) {
              console.warn(`[BridgeServicePortForward] Failed to inspect/kill process ${pid}:`, error)
            }
          }
          // 等待一下，让端口释放
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      } catch (error: any) {
        // 如果没有进程占用端口，lsof 会返回错误，这是正常的
        if (!error.message.includes('No such process')) {
          console.log(`[BridgeServicePortForward] Port ${this.forwardPort} is not in use`)
        }
      }
    } catch (error) {
      console.warn(`[BridgeServicePortForward] Failed to cleanup existing port forward:`, error)
    }
  }

  /**
   * 连接到 iOS Companion Service（通过端口转发）
   */
  async connect(device: IOSDevice): Promise<void> {
    // 如果已连接到同一设备且连接健康，直接返回
    if (this.connected && this.device?.udid === device.udid && this.isConnectionHealthy()) {
      console.log(`[BridgeServicePortForward] Already connected to device: ${device.udid}`)
      return
    }

    // 清理旧连接
    await this.disconnect()

    this.device = device
    const udid = device.udid

    console.log(`[BridgeServicePortForward] Connecting to device: ${udid}`)

    try {
      // 1. 建立端口转发（使用 go-ios）
      await this.setupPortForward(udid)
      console.log(`[BridgeServicePortForward] ✅ Port forward established: localhost:${this.forwardPort} -> device:${this.forwardPort}`)

      // 2. 连接到本地转发端口
      await this.connectToLocalPort()
      console.log('[BridgeServicePortForward] ✅ Connected to iOS Companion Service via port forward')

      this.connected = true
    } catch (error) {
      console.error('[BridgeServicePortForward] ❌ Connection failed:', error)
      await this.disconnect()
      throw error
    }
  }

  /**
   * 建立端口转发
   */
  private async setupPortForward(udid: string): Promise<void> {
    // 先检查并清理可能存在的旧进程
    await this.cleanupExistingPortForward()
    
    return new Promise((resolve, reject) => {
      const iosPath = getIOSCommandPath()
      const cwd = process.env.IOS_COMMAND_PATH || (typeof global !== 'undefined' && (global as any).electronApp && (global as any).electronApp.isPackaged)
        ? path.dirname(path.dirname(iosPath))  // Resources 目录
        : process.cwd()
      
      console.log(`[BridgeServicePortForward] Setting up port forward: localhost:${this.forwardPort} -> device:${this.forwardPort}`)
      console.log(`[BridgeServicePortForward] Using iOS command: ${iosPath}, cwd: ${cwd}`)
      console.log(`[BridgeServicePortForward] Command: ${iosPath} forward ${this.forwardPort} ${this.forwardPort} --udid=${udid}`)
      
      const forwardProcess = spawn(iosPath, [
        'forward',
        `${this.forwardPort}`,
        `${this.forwardPort}`,
        `--udid=${udid}`
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cwd
      })

      this.forwardProcess = forwardProcess

      let stdout = ''
      let stderr = ''

      forwardProcess.stdout?.on('data', (data) => {
        const output = data.toString()
        stdout += output
        console.log(`[BridgeServicePortForward] [stdout] ${output.trim()}`)
      })

      forwardProcess.stderr?.on('data', (data) => {
        const output = data.toString()
        stderr += output
        console.log(`[BridgeServicePortForward] [stderr] ${output.trim()}`)
      })

      forwardProcess.on('error', (error) => {
        console.error(`[BridgeServicePortForward] Process error:`, error)
        reject(new Error(`Failed to start port forward: ${error.message}`))
      })

      forwardProcess.on('exit', (code, signal) => {
        if (code !== null && code !== 0 && !forwardProcess.killed) {
          // 只有在非正常退出且不是被我们杀死的情况下才报错
          console.error(`[BridgeServicePortForward] Port forward process exited with code ${code}`)
          console.error(`[BridgeServicePortForward] stderr: ${stderr}`)
          // 注意：go-ios forward 可能会因为无法连接而退出，但我们仍然尝试连接
          // 因为有时服务需要一点时间才能准备好
        } else if (signal) {
          console.log(`[BridgeServicePortForward] Port forward process killed with signal ${signal}`)
        }
      })

      // 等待一下，确保转发已建立
      // 注意：即使 go-ios forward 报错，我们仍然尝试连接，因为有时服务需要时间准备
      setTimeout(() => {
        if (forwardProcess.killed) {
          reject(new Error('Port forward process was killed'))
        } else {
          // 检查 stderr 中是否有连接错误
          if (stderr.includes('could not connect to phone') || stderr.includes('error code:2')) {
            console.warn(`[BridgeServicePortForward] ⚠️ go-ios forward reported connection error, but continuing...`)
            console.warn(`[BridgeServicePortForward] This might be normal if the service needs time to start`)
          }
          console.log(`[BridgeServicePortForward] ✅ Port forward process started (PID: ${forwardProcess.pid})`)
          // 即使有错误，我们也继续，因为有时服务需要一点时间
          resolve()
        }
      }, 2000) // 增加等待时间到 2 秒
    })
  }

  /**
   * 连接到本地转发端口
   */
  private async connectToLocalPort(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket()
      this.serviceSocket = socket

      let connected = false
      const timeout = setTimeout(() => {
        if (!connected) {
          socket.destroy()
          console.error(`[BridgeServicePortForward] ❌ Connection timeout after 5 seconds`)
          console.error(`[BridgeServicePortForward] Failed to connect to localhost:${this.forwardPort}`)
          console.error(`[BridgeServicePortForward] Possible causes:`)
          console.error(`[BridgeServicePortForward]   1. Port forward process failed to start`)
          console.error(`[BridgeServicePortForward]   2. iOS Companion Service app is not running`)
          console.error(`[BridgeServicePortForward]   3. iOS Companion Service app is not listening on port ${this.forwardPort}`)
          console.error(`[BridgeServicePortForward]   4. Port ${this.forwardPort} is blocked or in use`)
          reject(new Error(`Connection timeout: Failed to connect to localhost:${this.forwardPort} after 5 seconds`))
        }
      }, 5000)

      socket.on('connect', () => {
        connected = true
        clearTimeout(timeout)
        console.log(`[BridgeServicePortForward] ✅ Connected to localhost:${this.forwardPort}`)
        this.setupMessageHandler()
        resolve()
      })

      socket.on('error', (error) => {
        clearTimeout(timeout)
        console.error(`[BridgeServicePortForward] Socket error:`, error)
        if (!connected) {
          reject(error)
        }
      })

      socket.on('close', () => {
        console.log('[BridgeServicePortForward] Socket closed during connection')
        this.connected = false
        if (!connected) {
          reject(new Error('Socket closed before connection established'))
        }
      })

      // 连接到本地转发端口
      console.log(`[BridgeServicePortForward] Connecting to localhost:${this.forwardPort}...`)
      socket.connect(this.forwardPort, '127.0.0.1')
    })
  }

  /**
   * 设置消息处理器（使用二进制帧格式）
   */
  private setupMessageHandler(): void {
    if (!this.serviceSocket) return

    this.receiveBuffer = Buffer.alloc(0)

    this.serviceSocket.on('data', (data: Buffer) => {
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, data])
      this.processFrames()
    })

    this.serviceSocket.on('error', (error) => {
      console.error('[BridgeServicePortForward] ❌ Socket error:', error)
      console.error('[BridgeServicePortForward] Connection failed due to socket error')
      this.connected = false
      // 清理所有待处理的请求
      for (const [id, pending] of this.pendingRequests.entries()) {
        pending.reject(new Error(`Socket error: ${error.message || String(error)}`))
      }
      this.pendingRequests.clear()
    })

    this.serviceSocket.on('close', () => {
      const wasConnected = this.connected
      console.log('[BridgeServicePortForward] Socket closed')
      if (wasConnected) {
        console.error('[BridgeServicePortForward] ❌ Connection closed unexpectedly')
      }
      this.connected = false
      // 清理所有待处理的请求
      for (const [id, pending] of this.pendingRequests.entries()) {
        pending.reject(new Error('Connection closed'))
      }
      this.pendingRequests.clear()
    })
  }

  /**
   * 处理接收到的帧（使用二进制帧格式）
   */
  private processFrames(): void {
    try {
      while (true) {
        // 检查连接状态
        if (!this.connected || !this.serviceSocket || this.serviceSocket.destroyed) {
          console.error('[BridgeServicePortForward] ❌ Connection lost during frame processing')
          this.connected = false
          // 清理所有待处理的请求
          for (const [id, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Connection lost during frame processing'))
          }
          this.pendingRequests.clear()
          break
        }

        const { frame, remaining } = FrameSerializer.extractFrame(this.receiveBuffer)
        
        if (!frame) {
          // 帧不完整，等待更多数据
          break
        }

        this.receiveBuffer = remaining
        this.handleFrame(frame)
      }
    } catch (error) {
      console.error('[BridgeServicePortForward] ❌ Error processing frames:', error)
      console.error('[BridgeServicePortForward] Connection may be lost')
      this.connected = false
      // 清理所有待处理的请求
      for (const [id, pending] of this.pendingRequests.entries()) {
        pending.reject(new Error(`Frame processing error: ${error instanceof Error ? error.message : String(error)}`))
      }
      this.pendingRequests.clear()
    }
  }

  /**
   * 处理帧（使用二进制帧格式）
   */
  private handleFrame(frame: Frame): void {
    try {
      // 检查连接状态
      if (!this.connected || !this.serviceSocket || this.serviceSocket.destroyed) {
        console.error('[BridgeServicePortForward] ❌ Connection lost, cannot handle frame')
        return
      }

      const { header, payload } = frame
      const { type, requestId } = header

      console.log(`[BridgeServicePortForward] Received frame: type=${type}, requestId=${requestId}, payloadLen=${payload.length}`)

      const pending = this.pendingRequests.get(requestId)
      if (!pending) {
        console.warn(`[BridgeServicePortForward] Received frame for unknown requestId: ${requestId}`)
        return
      }

      if (type === FrameType.DATA) {
        // 数据帧（用于缩略图、图片、视频）
        if (pending.stream) {
          // 流式响应（图片、视频）
          if (payload.length === 0) {
            // 空 payload 表示流结束
            console.log(`[BridgeServicePortForward] Stream ended for requestId ${requestId}`)
            pending.stream.push(null)
            this.pendingRequests.delete(requestId)
          } else {
            // 推送数据块
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
        console.error(`[BridgeServicePortForward] ❌ Error frame received for requestId ${requestId}: ${errorMsg}`)
        console.error(`[BridgeServicePortForward] This may indicate a connection failure on the iOS side`)
        pending.reject(new Error(errorMsg))
        this.pendingRequests.delete(requestId)
      } else {
        // 其他类型的响应帧（如 LIST_ASSETS、OPEN_URL 的 JSON 响应）
        try {
          const jsonStr = payload.toString('utf-8')
          console.log(`[BridgeServicePortForward] Received JSON response for requestId ${requestId}, type=${type}, length=${jsonStr.length}`)
          const json = JSON.parse(jsonStr)
          
          // 特殊处理 OPEN_URL 和 AUTO_LOGIN 响应
          if (type === FrameType.OPEN_URL || type === FrameType.AUTO_LOGIN) {
            console.log(`[BridgeServicePortForward] ✅ Parsed ${type === FrameType.OPEN_URL ? 'OPEN_URL' : 'AUTO_LOGIN'} response for requestId ${requestId}:`, json)
            pending.resolve(json)
            this.pendingRequests.delete(requestId)
          } else {
            // LIST_ASSETS 等请求的响应
            console.log(`[BridgeServicePortForward] ✅ Parsed JSON response for requestId ${requestId}:`, {
              total: json.total,
              itemsCount: json.items?.length || 0
            })
            pending.resolve(json)
            this.pendingRequests.delete(requestId)
          }
        } catch (error) {
          console.error(`[BridgeServicePortForward] ❌ Failed to parse JSON response for requestId ${requestId}, type=${type}:`, error)
          console.error(`[BridgeServicePortForward] Payload preview: ${payload.toString('utf-8').substring(0, 200)}`)
          console.error(`[BridgeServicePortForward] This may indicate a connection failure or protocol mismatch`)
          pending.reject(new Error('Invalid JSON response'))
          this.pendingRequests.delete(requestId)
        }
      }
    } catch (error) {
      console.error('[BridgeServicePortForward] ❌ Error handling frame:', error)
      console.error('[BridgeServicePortForward] Connection may be lost or corrupted')
      // 尝试清理相关的 pending request
      if (frame && frame.header) {
        const pending = this.pendingRequests.get(frame.header.requestId)
        if (pending) {
          pending.reject(new Error(`Frame handling error: ${error instanceof Error ? error.message : String(error)}`))
          this.pendingRequests.delete(frame.header.requestId)
        }
      }
    }
  }

  /**
   * 检查连接健康状态
   */
  private isConnectionHealthy(): boolean {
    if (!this.connected || !this.serviceSocket) {
      return false
    }
    
    // 检查 socket 是否已销毁
    if (this.serviceSocket.destroyed) {
      console.warn('[BridgeServicePortForward] Socket is destroyed')
      this.connected = false
      return false
    }
    
    // 检查 socket 是否可写
    if (!this.serviceSocket.writable) {
      console.warn('[BridgeServicePortForward] Socket is not writable')
      this.connected = false
      return false
    }
    
    return true
  }

  /**
   * 确保连接有效，如果无效则重连
   */
  private async ensureConnected(): Promise<void> {
    if (this.isConnectionHealthy()) {
      return // 连接健康，直接返回
    }
    
    console.log('[BridgeServicePortForward] Connection is not healthy, attempting to reconnect...')
    
    // 清理旧连接
    if (this.serviceSocket) {
      try {
        this.serviceSocket.destroy()
      } catch (error) {
        // 忽略错误
      }
      this.serviceSocket = null
    }
    
    this.connected = false
    
    // 重新连接
    if (!this.device) {
      throw new Error('No device set, cannot reconnect')
    }
    
    await this.connect(this.device)
  }

  /**
   * 发送请求并等待响应（使用二进制帧格式）
   */
  private async sendRequest(type: FrameType, payload: any, expectStream: boolean = false): Promise<any> {
    // 确保连接有效
    await this.ensureConnected()
    
    if (!this.connected || !this.serviceSocket) {
      throw new Error('Not connected to iOS Companion Service')
    }

    const requestId = ++this.requestIdCounter
    const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf-8')
    const frame = FrameSerializer.serialize(type, requestId, payloadBuffer)

    console.log(`[BridgeServicePortForward] Sending frame: type=${type}, requestId=${requestId}, size=${frame.length} bytes`)

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

      // 添加超时处理（视频流需要更长的超时时间）
      const timeoutDuration = expectStream && (type === FrameType.GET_VIDEO || type === FrameType.GET_IMAGE) 
        ? 600000 // 视频/图片流：600 秒（10分钟，大文件需要更长时间）
        : 60000 // 其他请求：60 秒（缩略图等）
      
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId)
        if (pending) {
          this.pendingRequests.delete(requestId)
          if (pending.stream) {
            // 流式请求超时，结束流
            pending.stream.push(null)
          }
          reject(new Error(`Request timeout for requestId ${requestId} (${timeoutDuration / 1000}s)`))
        }
      }, timeoutDuration)

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
          console.error(`[BridgeServicePortForward] Failed to send frame:`, error)
          reject(error)
        } else {
          console.log(`[BridgeServicePortForward] Frame sent successfully`)
        }
      })
    })
  }

  /**
   * 获取资源列表
   */
  async listAssets(limit: number, offset: number): Promise<{ total: number; items: any[] }> {
    return this.sendRequest(FrameType.LIST_ASSETS, { limit, offset })
  }

  /**
   * 获取缩略图（返回 JPEG Buffer）
   * GET_THUMB 响应：单个 DATA 帧包含完整 JPEG
   */
  async getThumbnail(assetId: string, size: number): Promise<Buffer> {
    const response = await this.sendRequest(FrameType.GET_THUMB, { assetId, size }, false)
    // response 应该是 Buffer（DATA 帧的 payload）
    return Buffer.isBuffer(response) ? response : Buffer.alloc(0)
  }

  /**
   * 获取图片
   */
  async getImage(assetId: string, quality: 'full' | 'screen' = 'full', format: 'jpeg' | 'heic' = 'jpeg'): Promise<Readable> {
    return this.sendRequest(FrameType.GET_IMAGE, { assetId, quality, format }, true)
  }

  /**
   * 获取视频流
   */
  async getVideoStream(assetId: string): Promise<Readable> {
    return this.sendRequest(FrameType.GET_VIDEO, { assetId }, true)
  }

  /**
   * 在设备侧发起 HTTP 请求并返回响应数据
   */
  async httpRequest(options: {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  }): Promise<any> {
    const payload: any = {
      url: options.url,
      method: (options.method || 'GET').toUpperCase(),
      headers: options.headers || {},
      body: options.body || ''
    }

    if (options.timeoutMs && Number.isFinite(options.timeoutMs)) {
      payload.timeout = options.timeoutMs
    }

    console.log(`[BridgeServicePortForward] 📤 Sending HTTP_REQUEST: ${payload.method} ${payload.url}`)
    return this.sendRequest(FrameType.HTTP_REQUEST, payload, false)
  }

  /**
   * 打开 URL（通过 WKWebView）
   */
  async openURL(url: string): Promise<void> {
    console.log(`[BridgeServicePortForward] 📤 Sending OPEN_URL request: ${url}`)
    try {
      const response = await this.sendRequest(FrameType.OPEN_URL, { url }, false)
      console.log(`[BridgeServicePortForward] 📥 Received OPEN_URL response:`, response)
      
      // OPEN_URL 响应应该是成功状态
      if (response && response.status === 'success') {
        console.log(`[BridgeServicePortForward] ✅ URL opened successfully: ${url}`)
        console.log(`[BridgeServicePortForward] Response URL: ${response.url || 'N/A'}`)
      } else {
        const errorMsg = response?.error || response?.message || 'Unknown error'
        console.error(`[BridgeServicePortForward] ❌ Failed to open URL: ${errorMsg}`)
        console.error(`[BridgeServicePortForward] Response:`, JSON.stringify(response, null, 2))
        throw new Error(`Failed to open URL: ${errorMsg}`)
      }
    } catch (error) {
      console.error(`[BridgeServicePortForward] ❌ Error in openURL:`, error)
      throw error
    }
  }

  /**
   * 自动登录（通过 iOS Companion AUTO_LOGIN 命令）
   */
  async autoLogin(phone: string, env?: string, extra?: any): Promise<any> {
    console.log(`[BridgeServicePortForward] 📤 Sending AUTO_LOGIN request: phone=${phone}, env=${env || ''}`)
    const payload: any = { phone }
    if (env) payload.env = env
    if (extra) payload.extra = extra

    try {
      const resp = await this.sendRequest(FrameType.AUTO_LOGIN, payload, false)
      console.log('[BridgeServicePortForward] 📥 AUTO_LOGIN response:', resp)
      return resp
    } catch (e) {
      console.error('[BridgeServicePortForward] ❌ AUTO_LOGIN failed:', e)
      throw e
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.serviceSocket) {
      this.serviceSocket.destroy()
      this.serviceSocket = null
    }

    if (this.forwardProcess) {
      this.forwardProcess.kill('SIGTERM')
      // 等待进程退出
      await new Promise((resolve) => {
        if (this.forwardProcess) {
          this.forwardProcess.on('exit', () => resolve(undefined))
          setTimeout(() => resolve(undefined), 1000) // 超时 1 秒
        } else {
          resolve(undefined)
        }
      })
      this.forwardProcess = null
    }

    // 清理所有待处理的请求
    for (const [id, pending] of this.pendingRequests.entries()) {
      pending.reject(new Error('Disconnected'))
    }
    this.pendingRequests.clear()

    this.connected = false
    this.device = null
    console.log('[BridgeServicePortForward] Disconnected')
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.connected
  }
}
