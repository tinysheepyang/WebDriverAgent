/**
 * 挂载 Developer Disk Image 工具
 * 
 * 用于在连接失败时手动挂载 Developer Disk Image
 * 
 * 对于 iOS 17+ 设备，需要先启动 go-ios 隧道
 */

import { spawn } from 'child_process'
import path from 'node:path'

async function startTunnel(udid: string): Promise<boolean> {
  return new Promise((resolve) => {
    // 使用 process.cwd() 获取项目根目录（mobile-tools-new）
    const projectRoot = process.cwd()
    const iosPath = path.join(projectRoot, 'commands', 'ios')
    
    console.log(`[MountDeveloperImage] Starting iOS tunnel for device: ${udid}`)
    console.log(`[MountDeveloperImage] Command: ENABLE_GO_IOS_AGENT=user ${iosPath} tunnel start --userspace --udid=${udid}`)
    
    const proc = spawn('sh', ['-c', `ENABLE_GO_IOS_AGENT=user "${iosPath}" tunnel start --userspace --udid=${udid}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: projectRoot,
      detached: false // 保持连接，但会在检测到启动后继续
    })

    let stdout = ''
    let stderr = ''
    let tunnelStarted = false
    let startupTimeout: NodeJS.Timeout | null = null

    // 设置超时：如果 10 秒内没有检测到启动信号，认为可能已经启动或失败
    startupTimeout = setTimeout(() => {
      if (!tunnelStarted) {
        console.log(`[MountDeveloperImage] ⚠️  Tunnel startup timeout, assuming it's running or already started`)
        console.log(`[MountDeveloperImage]    Continuing with mount attempt...`)
        tunnelStarted = true
        resolve(true)
      }
    }, 10000)

    proc.stdout?.on('data', (data) => {
      const output = data.toString()
      stdout += output
      console.log(`[MountDeveloperImage] [tunnel stdout] ${output.trim()}`)
      
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
        console.log(`[MountDeveloperImage] ✅ iOS tunnel started successfully`)
        console.log(`[MountDeveloperImage]    Waiting 3 seconds for tunnel to stabilize...`)
        // 等待隧道稳定，然后继续（不等待进程退出）
        setTimeout(() => {
          resolve(true)
        }, 3000)
      }
    })

    proc.stderr?.on('data', (data) => {
      const output = data.toString()
      stderr += output
      console.log(`[MountDeveloperImage] [tunnel stderr] ${output.trim()}`)
      
      // 检测启动成功的信号（从 stderr 也可能输出）
      if (!tunnelStarted && (
        output.includes('Tunnel server started') ||
        output.includes('start tunnel') ||
        output.includes('connect to lockdown tunnel') ||
        output.includes('Go-iOS Agent') && output.includes('ready')
      )) {
        tunnelStarted = true
        if (startupTimeout) {
          clearTimeout(startupTimeout)
          startupTimeout = null
        }
        console.log(`[MountDeveloperImage] ✅ iOS tunnel started successfully`)
        console.log(`[MountDeveloperImage]    Waiting 3 seconds for tunnel to stabilize...`)
        // 等待隧道稳定，然后继续（不等待进程退出）
        setTimeout(() => {
          resolve(true)
        }, 3000)
      }
    })

    proc.on('error', (error) => {
      console.error(`[MountDeveloperImage] Tunnel process error:`, error)
      if (startupTimeout) {
        clearTimeout(startupTimeout)
        startupTimeout = null
      }
      resolve(false)
    })

    // 注意：tunnel start 是长期运行的进程，不会自动退出
    // 我们通过检测启动信号来判断是否成功，而不是等待 exit
    proc.on('exit', (code) => {
      if (startupTimeout) {
        clearTimeout(startupTimeout)
        startupTimeout = null
      }
      
      // 如果进程退出了，说明可能有问题（正常情况下不会退出）
      if (!tunnelStarted) {
        console.error(`[MountDeveloperImage] ⚠️  Tunnel process exited with code ${code} before startup detected`)
        console.error(`[MountDeveloperImage]    This might indicate an error, but continuing with mount attempt...`)
        resolve(false) // 继续尝试挂载，可能隧道已经在运行
      }
      // 如果已经检测到启动，这里不需要做任何事（resolve 已经在启动检测时调用）
    })
  })
}

async function mountDeveloperImage(udid: string): Promise<boolean> {
  return new Promise((resolve) => {
    // 使用 process.cwd() 获取项目根目录（mobile-tools-new）
    const projectRoot = process.cwd()
    const iosPath = path.join(projectRoot, 'commands', 'ios')
    
    console.log(`[MountDeveloperImage] Mounting Developer Disk Image for device: ${udid}`)
    console.log(`[MountDeveloperImage] Command: ${iosPath} image auto --udid=${udid}`)
    
    const proc = spawn(iosPath, ['image', 'auto', `--udid=${udid}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: projectRoot
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      const output = data.toString()
      stdout += output
      console.log(`[MountDeveloperImage] [stdout] ${output.trim()}`)
    })

    proc.stderr?.on('data', (data) => {
      const output = data.toString()
      stderr += output
      console.log(`[MountDeveloperImage] [stderr] ${output.trim()}`)
    })

    proc.on('error', (error) => {
      console.error(`[MountDeveloperImage] Process error:`, error)
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
          console.log(`[MountDeveloperImage] ✅ Developer Disk Image mounted successfully`)
          resolve(true)
        } else {
          console.log(`[MountDeveloperImage] ⚠️  Process exited with code 0, but no success message found`)
          console.log(`[MountDeveloperImage] stderr: ${stderr}`)
          resolve(false)
        }
      } else {
        console.error(`[MountDeveloperImage] ❌ Process exited with code ${code}`)
        console.error(`[MountDeveloperImage] stderr: ${stderr}`)
        resolve(false)
      }
    })
  })
}

async function main() {
  const udid = process.argv[2]
  
  if (!udid) {
    console.log('Usage: tsx WebDriverAgent/photo-proxy/mount-developer-image.ts <UDID>')
    console.log('Example: tsx WebDriverAgent/photo-proxy/mount-developer-image.ts 00008110-001A29940120201E')
    process.exit(1)
  }

  console.log('='.repeat(60))
  console.log('Mount Developer Disk Image')
  console.log('='.repeat(60))
  console.log(`Device UDID: ${udid}`)
  console.log('='.repeat(60))
  console.log('')
  console.log('Step 1: Starting iOS tunnel (required for iOS 17+)...')
  console.log('')

  // 对于 iOS 17+，需要先启动隧道
  const tunnelStarted = await startTunnel(udid)
  
  if (!tunnelStarted) {
    console.log('⚠️  Tunnel start had issues, but continuing with mount attempt...')
    console.log('   (Tunnel might already be running)')
  }
  
  console.log('')
  console.log('Step 2: Mounting Developer Disk Image...')
  console.log('')

  const success = await mountDeveloperImage(udid)
  
  if (success) {
    console.log('\n✅ Developer Disk Image mounted successfully!')
    console.log('You can now try connecting to iOS Companion Service again.')
    process.exit(0)
  } else {
    console.log('\n❌ Failed to mount Developer Disk Image')
    console.log('\nTroubleshooting steps:')
    console.log('  1. Ensure iOS tunnel is running:')
    console.log(`     ./commands/ios tunnel start --userspace --udid=${udid}`)
    console.log('  2. Enable Developer Mode on device:')
    console.log('     Settings > Privacy & Security > Developer Mode')
    console.log('  3. Connect device to Xcode (auto-mounts DDI)')
    console.log('  4. Check if device needs to trust this computer')
    console.log('  5. Try manual mount:')
    console.log(`     ./commands/ios image auto --udid=${udid}`)
    process.exit(1)
  }
}

main().catch(console.error)
