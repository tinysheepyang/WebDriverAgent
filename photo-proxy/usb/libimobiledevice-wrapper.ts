/**
 * libimobiledevice 高级封装
 * 
 * 提供更友好的 API 来使用 libimobiledevice
 * 如果 libimobiledevice 不可用，会优雅降级
 */

import { spawn } from 'child_process'
import type { IOSDevice } from './device.js'

export interface PhotosServiceConnection {
  device: IOSDevice
  port: number
  sslEnabled: boolean
}

export class LibimobiledeviceWrapper {
  private available: boolean = false

  constructor() {
    // 检查 libimobiledevice 是否可用
    this.checkAvailability()
  }

  /**
   * 检查 libimobiledevice 是否可用
   */
  private async checkAvailability(): Promise<void> {
    try {
      // 尝试运行 idevice_id 命令
      const result = await this.runCommand('idevice_id', ['-l'])
      this.available = result.success
      if (this.available) {
        console.log('[LibimobiledeviceWrapper] ✅ libimobiledevice is available')
      } else {
        console.warn('[LibimobiledeviceWrapper] ⚠️ libimobiledevice not available')
      }
    } catch (error) {
      console.warn('[LibimobiledeviceWrapper] ⚠️ Failed to check libimobiledevice:', error)
      this.available = false
    }
  }

  /**
   * 运行命令
   */
  private runCommand(command: string, args: string[]): Promise<{ success: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        })
      })

      proc.on('error', () => {
        resolve({
          success: false,
          stdout: '',
          stderr: 'Command not found'
        })
      })
    })
  }

  /**
   * 检查是否可用
   */
  isAvailable(): boolean {
    return this.available
  }

  /**
   * 获取设备列表
   */
  async getDevices(): Promise<IOSDevice[]> {
    if (!this.available) {
      return []
    }

    try {
      const result = await this.runCommand('idevice_id', ['-l'])
      if (!result.success) {
        return []
      }

      const udids = result.stdout.split('\n').filter(udid => udid.trim())
      return udids.map(udid => ({
        udid: udid.trim(),
        name: undefined,
        productType: undefined,
        iosVersion: undefined
      }))
    } catch (error) {
      console.error('[LibimobiledeviceWrapper] Failed to get devices:', error)
      return []
    }
  }

  /**
   * 启动 Photos Service
   * 
   * 注意：libimobiledevice 可能不直接支持 Photos Service
   * 
   * 研究结果：
   * - libimobiledevice 主要通过文件系统访问照片（ifuse）
   * - 不直接支持 Photos Service 协议
   * - Photos Service 是 Apple 的私有协议，文档很少
   * 
   * 可能的方案：
   * 1. 使用 ifuse 挂载文件系统，访问 DCIM 目录（但无法获取系统缩略图）
   * 2. 使用自定义实现（usbmuxd + lockdownd + Photos Service 协议）
   * 3. 创建 iOS 应用桥接（使用 PHImageManager 和 AVAssetReader）
   * 
   * 当前：返回 null，表示需要 fallback 到自定义实现
   */
  async startPhotosService(device: IOSDevice): Promise<PhotosServiceConnection | null> {
    if (!this.available) {
      return null
    }

    // libimobiledevice 不直接支持 Photos Service
    // 需要 fallback 到自定义实现
    console.log('[LibimobiledeviceWrapper] libimobiledevice does not support Photos Service directly')
    console.log('[LibimobiledeviceWrapper] Falling back to custom implementation (usbmuxd + lockdownd)')
    return null
  }

  /**
   * 检查设备是否已配对
   */
  async isPaired(device: IOSDevice): Promise<boolean> {
    if (!this.available) {
      return false
    }

    try {
      const result = await this.runCommand('idevicepair', ['-u', device.udid, '-v'])
      return result.success
    } catch (error) {
      console.error('[LibimobiledeviceWrapper] Failed to check pairing:', error)
      return false
    }
  }

  /**
   * 配对设备
   */
  async pairDevice(device: IOSDevice): Promise<boolean> {
    if (!this.available) {
      return false
    }

    try {
      const result = await this.runCommand('idevicepair', ['-u', device.udid, 'pair'])
      return result.success
    } catch (error) {
      console.error('[LibimobiledeviceWrapper] Failed to pair device:', error)
      return false
    }
  }
}
