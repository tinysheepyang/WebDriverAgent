/**
 * libimobiledevice Node.js 绑定
 * 
 * 使用 node-ffi-napi 调用 libimobiledevice C 库
 * 
 * 注意：需要先安装 libimobiledevice：
 *   macOS: brew install libimobiledevice
 *   Linux: apt-get install libimobiledevice-dev
 */

// @ts-ignore - ffi-napi 是可选依赖
import { Library } from 'ffi-napi'
// @ts-ignore - ref-napi 是可选依赖
import { ref, types } from 'ref-napi'
import type { IOSDevice } from './device.js'

// libimobiledevice 库路径
const getLibraryPath = (): string => {
  const platform = process.platform
  if (platform === 'darwin') {
    // macOS: 通常在 /opt/homebrew/lib 或 /usr/local/lib
    return '/opt/homebrew/lib/libimobiledevice.dylib'
  } else if (platform === 'linux') {
    return 'libimobiledevice.so.6'
  } else {
    throw new Error(`Unsupported platform: ${platform}`)
  }
}

// 定义 C 函数签名
const ideviceFunctions = {
  // idevice_new: idevice_t** device, const char* udid
  idevice_new: ['int', ['pointer', 'string']],
  
  // idevice_free: idevice_t* device
  idevice_free: ['void', ['pointer']],
  
  // idevice_get_udid: idevice_t* device, char** udid
  idevice_get_udid: ['int', ['pointer', 'pointer']],
  
  // lockdownd_client_new: idevice_t* device, lockdownd_client_t** client, const char* label
  lockdownd_client_new: ['int', ['pointer', 'pointer', 'string']],
  
  // lockdownd_client_free: lockdownd_client_t* client
  lockdownd_client_free: ['void', ['pointer']],
  
  // lockdownd_start_service: lockdownd_client_t* client, const char* identifier, lockdownd_service_descriptor_t** service
  lockdownd_start_service: ['int', ['pointer', 'string', 'pointer']],
  
  // lockdownd_service_descriptor_free: lockdownd_service_descriptor_t* service
  lockdownd_service_descriptor_free: ['void', ['pointer']],
}

export class LibimobiledeviceClient {
  private library: Library | null = null
  private initialized: boolean = false

  constructor() {
    try {
      const libPath = getLibraryPath()
      this.library = Library(libPath, ideviceFunctions)
      this.initialized = true
      console.log('[LibimobiledeviceClient] ✅ Library loaded:', libPath)
    } catch (error) {
      console.error('[LibimobiledeviceClient] ❌ Failed to load library:', error)
      console.error('[LibimobiledeviceClient] Please install libimobiledevice:')
      console.error('  macOS: brew install libimobiledevice')
      console.error('  Linux: apt-get install libimobiledevice-dev')
      this.initialized = false
    }
  }

  /**
   * 检查库是否可用
   */
  isAvailable(): boolean {
    return this.initialized && this.library !== null
  }

  /**
   * 创建设备连接
   */
  async createDevice(udid?: string): Promise<Buffer> {
    if (!this.library) {
      throw new Error('Library not loaded')
    }

    const devicePtr = ref.alloc(types.pointer)
    const udidStr = udid || null
    
    const result = this.library.idevice_new(devicePtr, udidStr)
    
    if (result !== 0) {
      throw new Error(`Failed to create device: error code ${result}`)
    }

    return devicePtr.deref()
  }

  /**
   * 释放设备连接
   */
  freeDevice(device: Buffer): void {
    if (!this.library) {
      return
    }
    this.library.idevice_free(device)
  }

  /**
   * 创建 lockdownd 客户端
   */
  async createLockdowndClient(device: Buffer): Promise<Buffer> {
    if (!this.library) {
      throw new Error('Library not loaded')
    }

    const clientPtr = ref.alloc(types.pointer)
    const label = 'photo-proxy'
    
    const result = this.library.lockdownd_client_new(device, clientPtr, label)
    
    if (result !== 0) {
      throw new Error(`Failed to create lockdownd client: error code ${result}`)
    }

    return clientPtr.deref()
  }

  /**
   * 释放 lockdownd 客户端
   */
  freeLockdowndClient(client: Buffer): void {
    if (!this.library) {
      return
    }
    this.library.lockdownd_client_free(client)
  }

  /**
   * 启动服务
   */
  async startService(client: Buffer, serviceName: string): Promise<{ port: number; sslEnabled: boolean }> {
    if (!this.library) {
      throw new Error('Library not loaded')
    }

    const servicePtr = ref.alloc(types.pointer)
    
    const result = this.library.lockdownd_start_service(client, serviceName, servicePtr)
    
    if (result !== 0) {
      throw new Error(`Failed to start service ${serviceName}: error code ${result}`)
    }

    // TODO: 解析 service_descriptor 结构体获取端口号
    // 这需要了解 lockdownd_service_descriptor_t 的结构
    // 暂时返回占位值
    return {
      port: 0, // 需要从 servicePtr 中读取
      sslEnabled: false
    }
  }

  /**
   * 释放服务描述符
   */
  freeServiceDescriptor(service: Buffer): void {
    if (!this.library) {
      return
    }
    this.library.lockdownd_service_descriptor_free(service)
  }
}
