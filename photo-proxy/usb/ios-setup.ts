/**
 * iOS 环境自动设置工具
 * 自动启动 iOS 隧道和挂载 Developer Disk Image
 */

import { spawn } from 'child_process'
import { promisify } from 'util'
import { exec } from 'child_process'
import path from 'node:path'

const execAsync = promisify(exec)

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
  // 3. 后备方案：使用当前工作目录
  return path.join(process.cwd(), 'commands', 'ios')
}

type IOSEnvironmentStatus = { tunnel: boolean; ddi: boolean }
type EnvironmentCacheEntry = {
  status: IOSEnvironmentStatus
  lastChecked: number
  inFlight?: Promise<IOSEnvironmentStatus>
}

// 缓存挂载结果，避免多处重复挂载导致冲突
const envCache = new Map<string, EnvironmentCacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 隧道检查仍按 5 分钟缓存，用于减少命令调用

// 单独缓存 DDI 挂载结果：一次挂载后全局复用，不再重复挂载
const ddiCache = new Map<string, { mounted: boolean; inFlight?: Promise<boolean> }>()

function isCacheValid(entry?: EnvironmentCacheEntry) {
  if (!entry) return false
  const age = Date.now() - entry.lastChecked
  return age < CACHE_TTL_MS && entry.status.ddi
}

export function resetIOSEnvironmentCache(udid?: string) {
  if (udid) {
    envCache.delete(udid)
    ddiCache.delete(udid)
  } else {
    envCache.clear()
    ddiCache.clear()
  }
}

/**
 * 确保 Developer Disk Image 只挂载一次（全局复用）
 */
async function ensureDeveloperImageMounted(udid: string): Promise<boolean> {
  const cacheEntry = ddiCache.get(udid)

  // 已经确认挂载，直接复用
  if (cacheEntry?.mounted) {
    return true
  }

  // 正在挂载，等待结果
  if (cacheEntry?.inFlight) {
    return cacheEntry.inFlight
  }

  // 创建新的挂载流程
  const mountPromise = (async () => {
    // 先检查当前状态，避免重复挂载
    const alreadyMounted = await checkDeveloperImageMounted(udid)
    if (alreadyMounted) {
      console.log(`[iOSSetup] ✅ Developer Disk Image already mounted (global cache)`)
      ddiCache.set(udid, { mounted: true })
      return true
    }

    const mounted = await mountDeveloperImage(udid)
    ddiCache.set(udid, { mounted })
    return mounted
  })()

  ddiCache.set(udid, { mounted: cacheEntry?.mounted ?? false, inFlight: mountPromise })

  // 等待结果并清理 inFlight
  try {
    const result = await mountPromise
    const entry = ddiCache.get(udid)
    if (entry) {
      entry.inFlight = undefined
      entry.mounted = result
      ddiCache.set(udid, entry)
    }
    return result
  } catch (error) {
    const entry = ddiCache.get(udid)
    if (entry) {
      entry.inFlight = undefined
      ddiCache.set(udid, entry)
    }
    throw error
  }
}

/**
 * 清理已存在的隧道进程（解决端口占用问题）
 */
async function cleanupExistingTunnel(udid: string): Promise<void> {
  try {
    const iosPath = getIOSCommandPath()
    
    console.log(`[iOSSetup] 🧹 Starting tunnel cleanup for device: ${udid}`)
    
    // 1. 先尝试停止隧道（使用 go-ios 命令）
    try {
      console.log(`[iOSSetup] Step 1: Stopping tunnel via go-ios command...`)
      await execAsync(`"${iosPath}" tunnel stop --udid=${udid} 2>&1`, { timeout: 5000 })
      console.log(`[iOSSetup] ✅ Tunnel stop command executed`)
    } catch (error: any) {
      // 停止失败可能表示隧道不存在，这是正常的
      if (!error.message?.includes('no tunnel') && !error.message?.includes('not running')) {
        console.warn(`[iOSSetup] ⚠️ Tunnel stop command failed: ${error.message}`)
      }
    }
    
    // 2. 查找并清理所有 go-ios tunnel 相关进程
    try {
      console.log(`[iOSSetup] Step 2: Finding tunnel processes...`)
      // 查找所有包含 "ios" 和 "tunnel" 的进程
      const { stdout } = await execAsync(`ps aux | grep -E "(ios|go-ios).*tunnel" | grep -v grep | awk '{print $2}'`, { timeout: 3000 })
      const pids = stdout.trim().split('\n').filter(Boolean)
      if (pids.length > 0) {
        console.log(`[iOSSetup] Found ${pids.length} tunnel-related processes: ${pids.join(', ')}`)
        for (const pid of pids) {
          try {
            // 先尝试 SIGTERM，再尝试 SIGKILL
            await execAsync(`kill -TERM ${pid} 2>&1`, { timeout: 1000 })
            await new Promise(resolve => setTimeout(resolve, 500))
            await execAsync(`kill -9 ${pid} 2>&1`, { timeout: 1000 })
            console.log(`[iOSSetup] ✅ Killed tunnel process: ${pid}`)
          } catch (error) {
            // 忽略错误（进程可能已经退出）
          }
        }
      } else {
        console.log(`[iOSSetup] No tunnel processes found`)
      }
    } catch (error) {
      // 查找进程失败，忽略
      console.warn(`[iOSSetup] ⚠️ Failed to find tunnel processes: ${error}`)
    }
    
    // 3. 检查并清理占用端口 60105 的进程（go-ios tunnel 默认端口）
    try {
      console.log(`[iOSSetup] Step 3: Checking port 60105...`)
      const { stdout } = await execAsync(`lsof -ti :60105 2>&1`, { timeout: 3000 })
      const portPids = stdout.trim().split('\n').filter(Boolean)
      if (portPids.length > 0) {
        console.log(`[iOSSetup] Found processes on port 60105: ${portPids.join(', ')}`)
        for (const pid of portPids) {
          try {
            await execAsync(`kill -9 ${pid} 2>&1`, { timeout: 1000 })
            console.log(`[iOSSetup] ✅ Killed process on port 60105: ${pid}`)
          } catch (error) {
            // 忽略错误
          }
        }
      }
    } catch (error) {
      // 端口可能未被占用，这是正常的
    }
    
    // 4. 等待端口释放
    await new Promise(resolve => setTimeout(resolve, 2000))
    console.log(`[iOSSetup] ✅ Tunnel cleanup completed`)
  } catch (error) {
    console.warn(`[iOSSetup] ⚠️ Failed to cleanup existing tunnel: ${error}`)
  }
}

/**
 * 检查 iOS 隧道是否正在运行
 */
export async function checkTunnelStatus(udid: string): Promise<boolean> {
  try {
    const iosPath = getIOSCommandPath()
    
    const { stdout } = await execAsync(`"${iosPath}" tunnel ls --udid=${udid} 2>&1`)
    const output = stdout.trim()
    
    if (output && !output.includes('no tunnel') && !output.includes('not running')) {
      return true
    }
    return false
  } catch (error) {
    // 如果命令失败，认为隧道未运行
    return false
  }
}

/**
 * 获取 iOS 版本（用于判断是否需要启动隧道）
 */
async function getIOSVersion(udid: string): Promise<string | null> {
  try {
    const iosPath = getIOSCommandPath()
    const { stdout } = await execAsync(`"${iosPath}" info --udid=${udid} 2>&1`, { timeout: 5000 })
    
    // 解析 JSON 输出
    const lines = stdout.trim().split('\n').filter(line => line.trim())
    for (const line of lines) {
      try {
        const data = JSON.parse(line)
        // 尝试多个可能的版本字段
        const version = data.ProductVersion || data.HumanReadableProductVersionString || data.version
        if (version) {
          return String(version)
        }
      } catch (error) {
        // 忽略 JSON 解析错误
      }
    }
  } catch (error) {
    console.warn(`[iOSSetup] Failed to get iOS version: ${error}`)
  }
  return null
}

/**
 * 检查 iOS 版本是否需要隧道（iOS 17+ 需要）
 */
async function needsTunnel(udid: string): Promise<boolean> {
  const version = await getIOSVersion(udid)
  if (!version) {
    // 无法获取版本，默认假设需要隧道（保守策略）
    console.log(`[iOSSetup] ⚠️ Cannot determine iOS version, assuming tunnel is needed`)
    return true
  }
  
  // 解析版本号（例如 "17.0" -> 17, "15.6" -> 15）
  const majorVersion = parseInt(version.split('.')[0], 10)
  const needs = majorVersion >= 17
  console.log(`[iOSSetup] iOS version: ${version} (major: ${majorVersion}), tunnel needed: ${needs}`)
  return needs
}

/**
 * 启动 iOS 隧道
 */
export async function startTunnel(udid: string): Promise<boolean> {
  // 先检查是否需要隧道（iOS <17 不需要）
  const requiresTunnel = await needsTunnel(udid)
  if (!requiresTunnel) {
    console.log(`[iOSSetup] ✅ iOS version < 17, tunnel not required`)
    return true // 返回成功，因为不需要隧道
  }
  
  // 注意：cleanupExistingTunnel 应该在调用 startTunnel 之前已经执行
  // 这里不再重复清理，避免不必要的延迟
  // 如果 setupIOSEnvironment 已经清理过，这里就不需要再清理了
  
  return new Promise((resolve) => {
    const iosPath = getIOSCommandPath()
    const projectRoot = process.env.IOS_COMMAND_PATH || (typeof global !== 'undefined' && (global as any).electronApp && (global as any).electronApp.isPackaged)
      ? path.dirname(path.dirname(iosPath))  // Resources 目录
      : process.cwd()
    
    console.log(`[iOSSetup] Starting iOS tunnel for device: ${udid}`)
    console.log(`[iOSSetup] Using iOS command: ${iosPath}, cwd: ${projectRoot}`)
    
    const proc = spawn('sh', ['-c', `ENABLE_GO_IOS_AGENT=user "${iosPath}" tunnel start --userspace --udid=${udid}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: projectRoot,
      detached: false
    })

    let stdout = ''
    let stderr = ''
    let tunnelStarted = false
    let startupTimeout: NodeJS.Timeout | null = null

    // 设置超时：如果 10 秒内没有检测到启动信号，认为可能已经启动或失败
    startupTimeout = setTimeout(() => {
      if (!tunnelStarted) {
        console.log(`[iOSSetup] ⚠️  Tunnel startup timeout, assuming it's running or already started`)
        tunnelStarted = true
        resolve(true)
      }
    }, 10000)

    proc.stdout?.on('data', (data) => {
      const output = data.toString()
      stdout += output
      
      // 检测启动成功的信号
      if (!tunnelStarted && (
        output.includes('Tunnel server started') ||
        output.includes('start tunnel') ||
        output.includes('connect to lockdown tunnel')
      )) {
        tunnelStarted = true
        if (startupTimeout) {
          clearTimeout(startupTimeout)
          startupTimeout = null
        }
        console.log(`[iOSSetup] ✅ iOS tunnel started successfully`)
        setTimeout(() => {
          resolve(true)
        }, 2000) // 等待 2 秒让隧道稳定
      }
    })

    proc.stderr?.on('data', (data) => {
      const output = data.toString()
      stderr += output
      
      // 检测端口占用错误
      if (output.includes('bind: address already in use') || output.includes('address already in use')) {
        console.error(`[iOSSetup] ❌ Tunnel port is already in use`)
        console.error(`[iOSSetup] This usually means another tunnel process is running`)
        console.error(`[iOSSetup] Port cleanup should have been done before starting, but port is still in use`)
        console.error(`[iOSSetup] This may indicate a race condition or incomplete cleanup`)
        
        // 不再重试，直接返回失败（避免多次密码输入）
        // 调用者应该先调用 cleanupExistingTunnel 再启动
        if (startupTimeout) {
          clearTimeout(startupTimeout)
          startupTimeout = null
        }
        resolve(false) // 返回失败，让调用者决定是否重试
        return
      }
      
      // 检测启动成功的信号（从 stderr 也可能输出）
      if (!tunnelStarted && (
        output.includes('Tunnel server started') ||
        output.includes('start tunnel') ||
        output.includes('connect to lockdown tunnel') ||
        (output.includes('Go-iOS Agent') && output.includes('ready'))
      )) {
        tunnelStarted = true
        if (startupTimeout) {
          clearTimeout(startupTimeout)
          startupTimeout = null
        }
        console.log(`[iOSSetup] ✅ iOS tunnel started successfully`)
        setTimeout(() => {
          resolve(true)
        }, 2000) // 等待 2 秒让隧道稳定
      }
    })

    proc.on('error', (error) => {
      console.error(`[iOSSetup] Tunnel process error:`, error)
      if (startupTimeout) {
        clearTimeout(startupTimeout)
        startupTimeout = null
      }
      resolve(false)
    })

    proc.on('exit', (code) => {
      if (startupTimeout) {
        clearTimeout(startupTimeout)
        startupTimeout = null
      }
      
      if (!tunnelStarted) {
        // 如果进程退出了，说明可能有问题（正常情况下不会退出）
        console.log(`[iOSSetup] ⚠️  Tunnel process exited with code ${code} before startup detected`)
        resolve(false)
      }
    })
  })
}

/**
 * 检查 Developer Disk Image 是否已挂载
 */
export async function checkDeveloperImageMounted(udid: string): Promise<boolean> {
  try {
    const iosPath = getIOSCommandPath()
    
    const { stdout, stderr } = await execAsync(`"${iosPath}" image list --udid=${udid} 2>&1`)
    const output = (stdout + stderr).trim()
    
    // 检查输出中是否包含成功挂载的标识
    if (output.includes('success mounting image') || 
        output.includes('already a developer image mounted') ||
        output.includes('mounted')) {
      return true
    }
    return false
  } catch (error) {
    return false
  }
}

/**
 * 挂载 Developer Disk Image
 */
export async function mountDeveloperImage(udid: string): Promise<boolean> {
  return new Promise((resolve) => {
    const iosPath = getIOSCommandPath()
    const projectRoot = process.env.IOS_COMMAND_PATH || (typeof global !== 'undefined' && (global as any).electronApp && (global as any).electronApp.isPackaged)
      ? path.dirname(path.dirname(iosPath))  // Resources 目录
      : process.cwd()
    
    console.log(`[iOSSetup] Mounting Developer Disk Image for device: ${udid}`)
    console.log(`[iOSSetup] Using iOS command: ${iosPath}, cwd: ${projectRoot}`)
    
    const proc = spawn(iosPath, ['image', 'auto', `--udid=${udid}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: projectRoot
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      const output = data.toString()
      stdout += output
    })

    proc.stderr?.on('data', (data) => {
      const output = data.toString()
      stderr += output
    })

    proc.on('error', (error) => {
      console.error(`[iOSSetup] Mount process error:`, error)
      resolve(false)
    })

    proc.on('exit', (code) => {
      if (code === 0) {
        // 检查输出中是否包含成功信息
        const successMessages = [
          'success mounting image',
          'already a developer image mounted',
          'mounted'
        ]
        
        const hasSuccess = successMessages.some(msg => 
          stderr.toLowerCase().includes(msg) || stdout.toLowerCase().includes(msg)
        )
        
        if (hasSuccess) {
          console.log(`[iOSSetup] ✅ Developer Disk Image mounted successfully`)
          resolve(true)
        } else {
          console.log(`[iOSSetup] ⚠️  Process exited with code 0, but no success message found`)
          resolve(false)
        }
      } else {
        console.error(`[iOSSetup] ❌ Mount process exited with code ${code}`)
        resolve(false)
      }
    })
  })
}

/**
 * 自动设置 iOS 环境（启动隧道和挂载 DDI）
 */
export async function setupIOSEnvironment(udid: string): Promise<{ tunnel: boolean; ddi: boolean }> {
  const existingEntry = envCache.get(udid)
  if (existingEntry?.inFlight) {
    console.log(`[iOSSetup] ♻️  Reusing in-flight environment setup for device: ${udid}`)
    return existingEntry.inFlight
  }

  const result: IOSEnvironmentStatus = existingEntry?.status ?? { tunnel: false, ddi: false }
  const setupPromise = (async () => {
    // 1. 检查并启动隧道（iOS 17+ 需要）
    console.log(`[iOSSetup] Checking iOS tunnel status...`)
    
    // 先检查是否需要隧道
    const requiresTunnel = await needsTunnel(udid)
    if (!requiresTunnel) {
      console.log(`[iOSSetup] ✅ iOS version < 17, tunnel not required`)
      result.tunnel = true // 标记为成功，因为不需要隧道
    } else {
      // 先检查隧道是否已经在运行
      const tunnelRunning = await checkTunnelStatus(udid)
      
      if (tunnelRunning) {
        console.log(`[iOSSetup] ✅ iOS tunnel is already running`)
        result.tunnel = true
      } else {
        // 在启动前先清理（避免端口占用）
        console.log(`[iOSSetup] Cleaning up existing tunnel before starting...`)
        await cleanupExistingTunnel(udid)
        
        console.log(`[iOSSetup] Starting iOS tunnel...`)
        result.tunnel = await startTunnel(udid)
        if (result.tunnel) {
          console.log(`[iOSSetup] ✅ iOS tunnel started`)
        } else {
          console.log(`[iOSSetup] ⚠️  Failed to start iOS tunnel (may already be running)`)
          // 即使启动失败，也继续尝试挂载（可能隧道已经在运行）
          result.tunnel = true
        }
      }
    }

    // 2. 检查并挂载 Developer Disk Image
    console.log(`[iOSSetup] Ensuring Developer Disk Image is mounted (global once)...`)
    result.ddi = await ensureDeveloperImageMounted(udid)
    if (result.ddi) {
      console.log(`[iOSSetup] ✅ Developer Disk Image ready (global cache)`)
    } else {
      console.log(`[iOSSetup] ⚠️  Failed to mount Developer Disk Image`)
    }

    return result
  })()

  envCache.set(udid, {
    status: existingEntry?.status ?? { tunnel: false, ddi: false },
    lastChecked: Date.now(),
    inFlight: setupPromise
  })

  try {
    const finalResult = await setupPromise
    envCache.set(udid, {
      status: finalResult,
      lastChecked: Date.now()
    })
    return finalResult
  } finally {
    const entry = envCache.get(udid)
    if (entry) {
      entry.inFlight = undefined
      envCache.set(udid, entry)
    }
  }
}
