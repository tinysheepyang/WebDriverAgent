/**
 * URL Service 连接管理
 * 
 * 实现路径：
 * 1. iOS 应用监听固定端口（12345）
 * 2. PC 端通过 go-ios forward 建立端口转发
 * 3. PC 端连接到本地转发端口
 * 4. 通过自定义协议发送打开 URL 的命令
 * 5. iOS Companion App 使用 WKWebView 打开 URL
 * 
 * 注意：用户应用无法通过 lockdownd 注册服务，因此使用端口转发方案
 */

import type { IOSDevice } from './device.js'
import { BridgeServicePortForward } from '../protocol/bridge-port-forward.js'
import { setupIOSEnvironment } from './ios-setup.js'
import { spawn } from 'child_process'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'node:path'

const execAsync = promisify(exec)

/**
 * 获取 go-ios 命令路径（与 ios-setup.ts 中的逻辑一致）
 */
function getIOSCommandPath(): string {
  if (process.env.IOS_COMMAND_PATH) {
    return process.env.IOS_COMMAND_PATH
  }
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
  return path.join(process.cwd(), 'commands', 'ios')
}

/**
 * 确保端口转发 8100 已建立（用于 WebDriverAgent）
 */
async function ensurePortForward8100(udid: string): Promise<boolean> {
  // 先检查是否已可访问
  try {
    const response = await fetch('http://127.0.0.1:8100/status', {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    })
    if (response.ok) {
      console.log(`[URLService] ✅ Port 8100 is already accessible`)
      return true
    }
  } catch (error) {
    // 不可访问，需要建立端口转发
  }

  // 检查是否已有端口转发进程
  try {
    const { stdout } = await execAsync(`lsof -i :8100 2>&1`)
    if (stdout && stdout.includes('LISTEN')) {
      console.log(`[URLService] ✅ Port 8100 is already forwarded`)
      // 等待一下，确保转发已生效
      await new Promise(resolve => setTimeout(resolve, 1000))
      // 再次检查
      try {
        const response = await fetch('http://127.0.0.1:8100/status', {
          method: 'GET',
          signal: AbortSignal.timeout(2000)
        })
        if (response.ok) {
          return true
        }
      } catch (error) {
        // 继续建立新的端口转发
      }
    }
  } catch (error) {
    // lsof 失败，继续建立端口转发
  }

  // 建立端口转发
  console.log(`[URLService] 🔧 Setting up port forward 8100->8100 for WebDriverAgent...`)
  const iosPath = getIOSCommandPath()
  const projectRoot = process.env.IOS_COMMAND_PATH || (typeof global !== 'undefined' && (global as any).electronApp && (global as any).electronApp.isPackaged)
    ? path.dirname(path.dirname(iosPath))
    : process.cwd()

  return new Promise((resolve) => {
    const forwardProcess = spawn(iosPath, [
      'forward',
      '8100',
      '8100',
      `--udid=${udid}`
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: projectRoot,
      detached: true // 在后台运行
    })

    let hasResolved = false

    // 等待 3 秒后检查端口是否可访问
    setTimeout(async () => {
      if (hasResolved) return
      
      try {
        const response = await fetch('http://127.0.0.1:8100/status', {
          method: 'GET',
          signal: AbortSignal.timeout(2000)
        })
        if (response.ok) {
          console.log(`[URLService] ✅ Port forward 8100->8100 established`)
          hasResolved = true
          resolve(true)
        } else {
          console.warn(`[URLService] ⚠️ Port forward process started but port 8100 not accessible yet`)
          hasResolved = true
          resolve(false)
        }
      } catch (error) {
        console.warn(`[URLService] ⚠️ Port forward process started but port 8100 not accessible: ${error}`)
        hasResolved = true
        resolve(false)
      }
    }, 3000)

    forwardProcess.on('error', (error) => {
      if (hasResolved) return
      console.error(`[URLService] ❌ Failed to start port forward: ${error.message}`)
      hasResolved = true
      resolve(false)
    })

    forwardProcess.on('exit', (code) => {
      if (hasResolved) return
      if (code === 0) {
        // 进程正常退出，可能已经建立转发
        console.log(`[URLService] Port forward process exited with code ${code}`)
      } else {
        console.warn(`[URLService] ⚠️ Port forward process exited with code ${code}`)
      }
    })
  })
}

export class URLService {
  private device: IOSDevice | null = null
  private bridgeService: BridgeServicePortForward | null = null
  private connected: boolean = false

  constructor() {
    // 使用 BridgeServicePortForward（通过端口转发连接）
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
   * 连接到 iOS Companion Service
   * 
   * 流程：
   * 1. 检查 / 启动 go-ios 隧道（tunnel）
   * 2. 检查 / 挂载 Developer Disk Image（DDI）
   * 3. 通过端口转发连接到 iOS Companion Service（端口 12345）
   */
  async connect(): Promise<boolean> {
    if (this.connected && this.bridgeService?.isConnected()) {
      return true
    }

    if (!this.device) {
      throw new Error('No device set')
    }

    const udid = this.getDeviceUDID()
    console.log('================ [URLService] START CONNECT =================')
    console.log(`[URLService] Step 1: Preparing to connect to device: ${udid}`)

    try {
      // 1. 检查 / 启动隧道 + 挂载 DDI（用于确保开发环境就绪）
      console.log('[URLService] Step 2: Ensuring iOS tunnel & Developer Disk Image...')
      const envResult = await setupIOSEnvironment(udid)
      console.log('[URLService] Step 2 result: iOS environment status:', {
        tunnel: envResult.tunnel,
        ddi: envResult.ddi
      })

      if (!envResult.tunnel) {
        console.warn('[URLService] ⚠️ iOS tunnel is not running (go-ios agent). Port forward may fail on iOS 17+')
      }

      if (!envResult.ddi) {
        console.warn('[URLService] ⚠️ Developer Disk Image is NOT mounted')
        console.warn('[URLService]    → Some low-level features may be unavailable')
      } else {
        console.log('[URLService] ✅ Developer Disk Image is mounted')
      }

      // 2. 通过端口转发连接（iOS 应用监听固定端口 12345）
      console.log('[URLService] Step 3: Connecting to iOS Companion Service via port forward...')
      console.log('[URLService] Prerequisites:')
      console.log('[URLService]   1. iOS Companion App is running in FOREGROUND')
      console.log('[URLService]   2. iOS Companion App is listening on port 12345')
      console.log('[URLService]   3. App Transport Security (ATS) allows the target URL (see Info.plist)')
      console.log('[URLService]   4. Port forwarding will be established automatically via go-ios forward')

      await this.bridgeService!.connect(this.device)
      this.connected = this.bridgeService!.isConnected()
      
      if (this.connected) {
        console.log('[URLService] Step 4: ✅ Connected to iOS Companion Service via port forward')
        console.log('================ [URLService] CONNECT SUCCESS ================')
        return true
      } else {
        // 连接失败，清理状态
        await this.disconnect()
        throw new Error('Connection failed: Bridge service is not connected')
      }
    } catch (error: any) {
      console.error('[URLService] ❌ Connection failed:', error)
      console.error('[URLService]    → Please check:')
      console.error('[URLService]      1) iOS Companion App is installed and running in foreground')
      console.error('[URLService]      2) Port 12345 is open in the app (see Xcode console: "Listener ready on port: 12345")')
      console.error('[URLService]      3) go-ios tunnel status (ios tunnel start) and Developer Mode on device')
      console.error('[URLService]      4) App Transport Security (ATS) configuration for the target URL')
      await this.disconnect()
      // 重新抛出错误，让调用者知道具体的失败原因
      throw new Error(error.message || 'Connection failed')
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
    console.log('[URLService] Disconnected')
  }

  /**
   * 检查服务是否可用
   */
  async isAvailable(): Promise<boolean> {
    try {
      if (!this.device) {
        return false
      }
      // 尝试连接以检查服务是否可用
      const connected = await this.connect()
      return connected
    } catch (error) {
      console.error('[URLService] Service not available:', error)
      return false
    }
  }

  /**
   * 打开 URL（通过 WKWebView）
   */
  async openURL(url: string): Promise<void> {
    if (!this.connected) {
      await this.connect()
    }

    if (!this.connected) {
      throw new Error('Not connected to iOS Companion Service')
    }

    console.log(`[URLService] 📤 Opening URL: ${url}`)
    try {
      await this.bridgeService!.openURL(url)
      console.log(`[URLService] ✅ URL opened successfully`)
    } catch (error: any) {
      console.error(`[URLService] ❌ Failed to open URL:`, error)
      console.error(`[URLService] Error message: ${error.message || String(error)}`)
      throw error
    }
  }

  /**
   * 自动登录（通过 iOS Companion AUTO_LOGIN 命令）
   * @param phone - 手机号
   * @param env - 环境（可选，默认 'test'）
   * @param extra - 额外参数（可选）
   */
  async autoLogin(phone: string, env?: string, extra?: any): Promise<any> {
    if (!this.connected) {
      await this.connect()
    }
    if (!this.connected) {
      throw new Error('Not connected to iOS Companion Service')
    }
    console.log(`[URLService] 📤 AUTO_LOGIN via Companion: phone=${phone}, env=${env || ''}`)
    return this.bridgeService!.autoLogin(phone, env, extra)
  }

  /**
   * 设备侧发起 HTTP 请求并返回响应（通过 Companion）
   * 
   * 注意：尝试通过 WebDriverAgent 的 HTTP API 在 iOS 端执行请求
   * 如果失败，回退到通过 Companion Service 执行
   */
  async httpRequest(options: {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  }): Promise<any> {
    // 首先尝试通过 WebDriverAgent 的 HTTP API 在 iOS 端执行
    // WebDriverAgent 运行在设备上，可能有更好的网络权限
    try {
      // 确保端口转发 8100 已建立
      if (this.device) {
        const udid = this.device.udid
        console.log(`[URLService] 🔧 Ensuring port forward 8100->8100 for WebDriverAgent...`)
        await ensurePortForward8100(udid)
      }
      
      // 使用 127.0.0.1 而不是 localhost，确保在 Node.js 中能正确解析
      const wdaBaseUrl = `http://127.0.0.1:8100`
      const wdaUrl = `${wdaBaseUrl}/photos/http-request`
      
      // 先检查 WebDriverAgent 是否可用
      console.log(`[URLService] 🔍 Checking WebDriverAgent availability: ${wdaBaseUrl}/status`)
      try {
        const statusResponse = await fetch(`${wdaBaseUrl}/status`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000) // 3秒超时
        })
        if (!statusResponse.ok) {
          throw new Error(`WebDriverAgent status check failed: ${statusResponse.status}`)
        }
        console.log(`[URLService] ✅ WebDriverAgent is available`)
      } catch (statusError: any) {
        const statusErrorMsg = statusError.message || String(statusError)
        console.warn(`[URLService] ⚠️ WebDriverAgent status check failed: ${statusErrorMsg}`)
        console.warn(`[URLService] ⚠️ WebDriverAgent may not be running. Please ensure WebDriverAgent is started.`)
        throw new Error(`WebDriverAgent not available: ${statusErrorMsg}`)
      }
      
      const wdaPayload = {
        url: options.url,
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body || '',
        timeout: options.timeoutMs ? options.timeoutMs / 1000 : 15.0
      }

      console.log(`[URLService] 📤 HTTP_REQUEST via WebDriverAgent (iOS): ${wdaPayload.method} ${options.url}`)
      console.log(`[URLService] WebDriverAgent URL: ${wdaUrl}`)
      
      // 添加超时控制
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), (options.timeoutMs || 15000) + 5000)
      
      const response = await fetch(wdaUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(wdaPayload),
        signal: controller.signal
      })
      
      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new Error(`WebDriverAgent HTTP API returned ${response.status}: ${errorText}`)
      }

      const result: any = await response.json()
      
      // WebDriverAgent 返回格式: { value: { status, headers, body } } 或 { status, headers, body }
      if (result.value) {
        console.log(`[URLService] ✅ HTTP request succeeded via WebDriverAgent: status=${result.value.status}, bodyLength=${result.value.body?.length || 0}`)
        return result.value
      } else if (result.status !== undefined) {
        // 如果直接返回结果
        console.log(`[URLService] ✅ HTTP request succeeded via WebDriverAgent: status=${result.status}, bodyLength=${result.body?.length || 0}`)
        return result
      } else if (result.error) {
        // WebDriverAgent 返回错误格式
        throw new Error(`WebDriverAgent error: ${result.error}`)
      } else {
        throw new Error(`Invalid response format from WebDriverAgent: ${JSON.stringify(result)}`)
      }
    } catch (wdaError: any) {
      const errorMsg = wdaError.message || String(wdaError)
      console.warn(`[URLService] ⚠️ WebDriverAgent HTTP API failed: ${errorMsg}`)
      
      // 如果是连接错误，说明 WebDriverAgent 可能没有运行
      if (errorMsg.includes('fetch failed') || errorMsg.includes('ECONNREFUSED') || errorMsg.includes('AbortError') || errorMsg.includes('not available')) {
        console.warn(`[URLService] ⚠️ WebDriverAgent is not available. Falling back to Companion Service.`)
      }
      
      console.log(`[URLService] 📤 Falling back to Companion Service (iOS): ${options.method || 'GET'} ${options.url}`)
      
      // 回退到通过 Companion Service 执行（iOS 端）
      if (!this.connected) {
        await this.connect()
      }
      if (!this.connected) {
        throw new Error('Not connected to iOS Companion Service')
      }
      
      return this.bridgeService!.httpRequest(options)
    }
  }
}

