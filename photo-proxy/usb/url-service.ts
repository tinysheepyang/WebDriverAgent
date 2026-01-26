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
    // 同步更新 BridgeServicePortForward 的设备信息（如果已初始化）
    if (this.bridgeService) {
      // 注意：这里不直接设置 bridgeService.device，而是通过 connect 方法设置
      // 但如果连接已断开，需要确保设备信息可用
      // 我们可以在 connect 时传递设备，但这里先确保设备信息可用
    }
  }

  /**
   * 获取当前设备（用于外部检查）
   */
  getDevice(): IOSDevice | null {
    return this.device
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
    // 确保设备已设置
    if (!this.device) {
      throw new Error('No device set. Please call setDevice() before autoLogin()')
    }
    
    // 如果连接不健康或未连接，先断开然后重新连接以确保设备信息同步
    // 这样可以确保 BridgeServicePortForward 的设备信息是最新的
    if (!this.connected || !this.bridgeService?.isConnected()) {
      // 先断开旧连接（如果有）
      if (this.bridgeService) {
        try {
          await this.bridgeService.disconnect()
        } catch (error) {
          // 忽略断开错误
        }
      }
      this.connected = false
      
      // 重新连接（这会传递最新的设备信息给 BridgeServicePortForward）
      await this.connect()
    }
    
    if (!this.connected) {
      throw new Error('Not connected to iOS Companion Service')
    }
    console.log(`[URLService] 📤 AUTO_LOGIN via Companion: phone=${phone}, env=${env || ''}`)
    
    // 调用 Companion Service 的 autoLogin
    const result = await this.bridgeService!.autoLogin(phone, env, extra)
    
    // iOS 15 及以下版本在打开自定义 URL scheme 时会弹出确认对话框
    // 需要自动点击确认按钮
    if (this.device) {
      const iosVersion = this.device.iosVersion || this.device.version
      if (iosVersion) {
        const majorVersion = parseInt(iosVersion.split('.')[0], 10)
        // iOS 15 及以下版本需要处理确认对话框
        if (majorVersion <= 15) {
          console.log(`[URLService] 🔔 iOS ${iosVersion} detected, waiting for confirmation dialog...`)
          try {
            // 等待确认对话框出现（通常需要 0.5-1 秒）
            await new Promise(resolve => setTimeout(resolve, 1000))
            
            // 确保端口转发 8100 已建立（用于 WebDriverAgent）
            await ensurePortForward8100(this.device.udid)
            
            // 使用 WebDriverAgent 的 Alert API 自动接受确认对话框
            const wdaBaseUrl = `http://127.0.0.1:8100`
            const alertTextResponse = await fetch(`${wdaBaseUrl}/alert/text`, {
              method: 'GET',
              signal: AbortSignal.timeout(3000)
            })
            
            if (alertTextResponse.ok) {
              const alertText = await alertTextResponse.text()
              console.log(`[URLService] 🔔 Found alert dialog: ${alertText}`)
              
              // 检查是否包含"小赢卡贷"或类似的确认对话框
              if (alertText && (alertText.includes('小赢卡贷') || alertText.includes('打开') || alertText.includes('Open'))) {
                console.log(`[URLService] ✅ Auto-accepting confirmation dialog...`)
                const acceptResponse = await fetch(`${wdaBaseUrl}/alert/accept`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  signal: AbortSignal.timeout(3000)
                })
                
                if (acceptResponse.ok) {
                  console.log(`[URLService] ✅ Confirmation dialog accepted successfully`)
                } else {
                  console.warn(`[URLService] ⚠️ Failed to accept alert: ${acceptResponse.status}`)
                }
              } else {
                console.log(`[URLService] ℹ️ Alert dialog found but doesn't match expected pattern, skipping auto-accept`)
              }
            } else {
              // 没有 Alert 对话框，这是正常的（可能已经自动处理或不需要确认）
              console.log(`[URLService] ℹ️ No alert dialog found (status: ${alertTextResponse.status}), this is normal`)
            }
          } catch (error: any) {
            // 处理 Alert 失败不影响登录流程，只记录警告
            console.warn(`[URLService] ⚠️ Failed to handle confirmation dialog: ${error.message || String(error)}`)
            console.warn(`[URLService] ⚠️ This is not critical, login may still succeed`)
          }
        }
      }
    }
    
    return result
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
    skipWDA?: boolean // 可选：跳过 WDA 尝试，直接使用 Companion Service
  }): Promise<any> {
    // 如果明确要求跳过 WDA，直接使用 Companion Service
    if (options.skipWDA) {
      console.log(`[URLService] 📤 Using Companion Service directly (WDA skipped): ${options.method || 'GET'} ${options.url}`)
      if (!this.connected) {
        await this.connect()
      }
      if (!this.connected) {
        throw new Error('Not connected to iOS Companion Service')
      }
      return this.bridgeService!.httpRequest(options)
    }

    // 首先尝试通过 WebDriverAgent 的 HTTP API 在 iOS 端执行
    // WebDriverAgent 运行在设备上，可能有更好的网络权限
    try {
      // 快速检查 WebDriverAgent 是否可用（不建立端口转发，直接检查）
      const wdaBaseUrl = `http://127.0.0.1:8100`
      console.log(`[URLService] 🔍 Quick checking WebDriverAgent availability: ${wdaBaseUrl}/status`)
      
      // 使用更短的超时时间（1秒），快速判断 WDA 是否可用
      try {
        const statusResponse = await fetch(`${wdaBaseUrl}/status`, {
          method: 'GET',
          signal: AbortSignal.timeout(1000) // 1秒超时，快速失败
        })
        if (!statusResponse.ok) {
          throw new Error(`WebDriverAgent status check failed: ${statusResponse.status}`)
        }
        console.log(`[URLService] ✅ WebDriverAgent is available`)
      } catch (statusError: any) {
        // 快速检查失败，立即回退到 Companion Service，不尝试建立端口转发
        const statusErrorMsg = statusError.message || String(statusError)
        console.warn(`[URLService] ⚠️ WebDriverAgent quick check failed: ${statusErrorMsg}`)
        console.warn(`[URLService] ⚠️ WebDriverAgent is not available. Falling back to Companion Service immediately.`)
        throw new Error(`WebDriverAgent not available: ${statusErrorMsg}`)
      }

      // WDA 可用，继续使用 WDA
      const wdaUrl = `${wdaBaseUrl}/photos/http-request`
      
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

