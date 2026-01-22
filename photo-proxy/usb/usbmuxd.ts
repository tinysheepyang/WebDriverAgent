/**
 * usbmuxd 客户端实现
 * 
 * usbmuxd 是 USB 多路复用守护进程，用于在 USB 上建立与 iOS 设备的连接
 * 
 * 协议格式：
 * - 消息头：32 字节（版本、消息类型、标签、payload 长度）
 * - Payload：根据消息类型不同（plist 格式）
 * 
 * 参考：
 * - https://github.com/libimobiledevice/usbmuxd
 * - https://www.theiphonewiki.com/wiki/Usbmux
 */

import { Socket } from 'net'
import { Duplex } from 'stream'
import { spawn } from 'child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import plist from 'plist'

// usbmuxd 消息类型
enum UsbmuxdMessageType {
  Result = 1,
  Connect = 2,
  Listen = 3,
  Add = 4,
  Remove = 5,
  Packet = 6,
  PlistPacket = 8,
  ListDevices = 9,
  ListListeners = 10,
  ReadBUID = 11,
  ReadPairRecord = 12,
  SavePairRecord = 13,
  DeletePairRecord = 14,
  Plist = 15
}

export interface UsbmuxdDevice {
  DeviceID: number
  MessageType: string
  Properties: {
    SerialNumber: string // UDID
    ConnectionSpeed: number
    ConnectionType: string
    DeviceID: number
    LocationID: number
    ProductID: number
  }
}

export interface UsbmuxdMessage {
  version: number
  message: number
  tag: number
  payload: Buffer
}

export class UsbmuxdClient {
  private socket: Socket | null = null
  private connected: boolean = false
  private tagCounter: number = 0
  private pendingRequests: Map<number, {
    resolve: (value: UsbmuxdMessage) => void
    reject: (error: Error) => void
  }> = new Map()
  private dataBuffer: Buffer = Buffer.alloc(0)
  // 存储设备连接：connectionId -> socket
  private deviceConnections: Map<number, Socket> = new Map()
  // 存储连接类型：connectionId -> 'lockdownd' | 'custom'
  private connectionTypes: Map<number, 'lockdownd' | 'custom'> = new Map()
  private connectionIdCounter: number = 0

  /**
   * 连接到 usbmuxd 守护进程
   * macOS: /var/run/usbmuxd (Unix socket)
   * Linux: /var/run/usbmuxd
   * Windows: 127.0.0.1:27015 (TCP)
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const isMac = process.platform === 'darwin'
      const isWindows = process.platform === 'win32'
      
      if (isMac || process.platform === 'linux') {
        // Unix socket
        const socketPath = '/var/run/usbmuxd'
        this.socket = new Socket()
        
        this.socket.connect(socketPath, () => {
          this.connected = true
          console.log('[UsbmuxdClient] ✅ Connected to usbmuxd (Unix socket)')
          this.setupMessageHandler()
          resolve()
        })
        
        this.socket.on('error', (error) => {
          console.error('[UsbmuxdClient] Connection error:', error)
          if (!this.connected) {
            reject(error)
          }
        })
      } else if (isWindows) {
        // TCP socket
        this.socket = new Socket()
        this.socket.connect(27015, '127.0.0.1', () => {
          this.connected = true
          console.log('[UsbmuxdClient] ✅ Connected to usbmuxd (TCP)')
          this.setupMessageHandler()
          resolve()
        })
        
        this.socket.on('error', (error) => {
          console.error('[UsbmuxdClient] Connection error:', error)
          if (!this.connected) {
            reject(error)
          }
        })
      } else {
        reject(new Error('Unsupported platform'))
      }
    })
  }

  /**
   * 设置消息处理器
   */
  private setupMessageHandler(): void {
    if (!this.socket) return

    this.socket.on('data', (data: Buffer) => {
      console.log(`[UsbmuxdClient] Received ${data.length} bytes of data`)
      this.dataBuffer = Buffer.concat([this.dataBuffer, data])
      this.processMessages()
    })

    this.socket.on('error', (error) => {
      console.error('[UsbmuxdClient] Socket error:', error)
      // 清理所有待处理的请求
      for (const [tag, pending] of this.pendingRequests.entries()) {
        pending.reject(error)
      }
      this.pendingRequests.clear()
    })

    this.socket.on('close', () => {
      console.log('[UsbmuxdClient] Socket closed')
      this.connected = false
      // 清理所有待处理的请求
      for (const [tag, pending] of this.pendingRequests.entries()) {
        pending.reject(new Error('Socket closed'))
      }
      this.pendingRequests.clear()
    })
  }

  /**
   * 处理接收到的消息
   */
  private processMessages(): void {
    while (this.dataBuffer.length >= 16) {
      // 读取消息长度（前 4 字节，小端序）
      const messageLength = this.dataBuffer.readUInt32LE(0)
      
      if (messageLength < 16 || messageLength > 1024 * 1024) {
        // 无效的消息长度，跳过第一个字节
        console.warn(`[UsbmuxdClient] Invalid message length: ${messageLength}`)
        this.dataBuffer = this.dataBuffer.slice(1)
        continue
      }

      if (this.dataBuffer.length < messageLength) {
        // 消息不完整，等待更多数据
        break
      }

      // 解析消息
      const message = this.parseMessage(this.dataBuffer.slice(0, messageLength))
      this.dataBuffer = this.dataBuffer.slice(messageLength)

      // 调试日志
      console.log(`[UsbmuxdClient] Received message: type=${message.message}, tag=${message.tag}, payload length=${message.payload.length}`)
      console.log(`[UsbmuxdClient] Pending requests: ${Array.from(this.pendingRequests.keys()).join(', ')}`)

      // 处理响应消息
      // 注意：ListDevices 的响应可能是 PlistPacket (8) 类型
      const pending = this.pendingRequests.get(message.tag)
      if (pending) {
        console.log(`[UsbmuxdClient] Found pending request for tag=${message.tag}, resolving...`)
        this.pendingRequests.delete(message.tag)
        // 使用 setImmediate 确保异步执行，避免阻塞
        setImmediate(() => {
          pending.resolve(message)
        })
      } else if (message.message === UsbmuxdMessageType.Packet) {
        // Packet 消息：转发到对应的设备连接
        this.handlePacketMessage(message)
      } else if (message.message === UsbmuxdMessageType.PlistPacket && message.tag === 0 && this.deviceConnections.size > 0) {
        // 关键修复：某些版本的 usbmuxd/iOS 使用 PlistPacket (type=8, tag=0) 来传输设备连接的数据
        // 我们需要根据连接类型决定如何处理：
        // - lockdownd 连接：转换为 lockdownd 格式（4字节长度 + plist payload）
        // - 自定义服务连接：直接转发原始数据
        
        console.log(`[UsbmuxdClient] Received PlistPacket with tag=0, payload length: ${message.payload.length}`)
        
        // 首先检查是否是 usbmuxd 错误消息
        try {
          const plistStr = message.payload.toString('utf-8')
          if (plistStr.includes('<key>MessageType</key>') && plistStr.includes('<key>Number</key>')) {
            const plistData = plist.parse(plistStr) as any
            if (plistData && plistData.MessageType === 'Result' && plistData.Number !== undefined) {
              const errorCode = plistData.Number
              if (errorCode !== 0) {
                console.error(`[UsbmuxdClient] ❌ Received usbmuxd error: Number=${errorCode}`)
                if (plistData.Error) {
                  console.error(`[UsbmuxdClient] Error message: ${plistData.Error}`)
                }
                
                // 关闭所有连接并触发错误
                const connectionId = Array.from(this.deviceConnections.keys())[0]
                const proxySocket = this.deviceConnections.get(connectionId)
                if (proxySocket) {
                  const errorMsg = plistData.Error || `usbmuxd error code ${errorCode}`
                  proxySocket.destroy()
                  proxySocket.emit('error', new Error(`Connection failed: ${errorMsg}`))
                }
                return
              }
            }
          }
        } catch (parseError) {
          // 不是 plist 格式，继续正常处理
          console.log(`[UsbmuxdClient] PlistPacket is not a usbmuxd error message, continuing...`)
        }
        
        // 获取连接 ID 和类型
        const connectionId = Array.from(this.deviceConnections.keys())[0]
        const connectionType = this.connectionTypes.get(connectionId) || 'custom'
        const proxySocket = this.deviceConnections.get(connectionId)
        
        if (!proxySocket) {
          console.warn(`[UsbmuxdClient] No proxy socket found for connectionId: ${connectionId}`)
          return
        }
        
        // 调试：打印前32字节的十六进制和ASCII
        const preview = message.payload.slice(0, Math.min(32, message.payload.length))
        const hexPreview = preview.toString('hex')
        const asciiPreview = preview.toString('ascii').replace(/[^\x20-\x7E]/g, '.')
        console.log(`[UsbmuxdClient] PlistPacket payload preview:`)
        console.log(`[UsbmuxdClient]   Hex: ${hexPreview}`)
        console.log(`[UsbmuxdClient]   ASCII: ${asciiPreview}`)
        console.log(`[UsbmuxdClient] Connection type: ${connectionType}`)
        
        if (connectionType === 'lockdownd') {
          // lockdownd 连接：检查是否是 plist XML 格式
          const payloadStr = message.payload.toString('utf-8', 0, Math.min(100, message.payload.length))
          const isPlistXML = payloadStr.trim().startsWith('<?xml') || payloadStr.trim().startsWith('<plist')
          
          if (isPlistXML) {
            // PlistPacket 的 payload 是 plist XML，需要转换为 lockdownd 协议格式
            console.log(`[UsbmuxdClient] PlistPacket contains plist XML, converting to lockdownd format`)
            
            // 创建 lockdownd 消息：4字节长度 + plist payload
            const lengthBuffer = Buffer.alloc(4)
            lengthBuffer.writeUInt32BE(message.payload.length, 0)
            const lockdowndMessage = Buffer.concat([lengthBuffer, message.payload])
            
            console.log(`[UsbmuxdClient] Created lockdownd message: length=${message.payload.length}, total=${lockdowndMessage.length}`)
            
            const pushed = proxySocket.push(lockdowndMessage)
            if (pushed) {
              console.log(`[UsbmuxdClient] ✅ Forwarded ${lockdowndMessage.length} bytes to lockdownd`)
            } else {
              console.warn(`[UsbmuxdClient] Proxy socket buffer full for connectionId: ${connectionId}`)
            }
          } else {
            // 可能是二进制格式，检查前4字节是否是合理的长度值
            if (message.payload.length >= 4) {
              const possibleLength = message.payload.readUInt32BE(0)
              if (possibleLength >= 4 && possibleLength <= 1024 * 1024 && possibleLength <= message.payload.length) {
                // 看起来已经是 lockdownd 格式（4字节长度头 + payload）
                console.log(`[UsbmuxdClient] PlistPacket appears to be in lockdownd format (length=${possibleLength})`)
                
                const pushed = proxySocket.push(message.payload)
                if (pushed) {
                  console.log(`[UsbmuxdClient] ✅ Forwarded ${message.payload.length} bytes to lockdownd`)
                } else {
                  console.warn(`[UsbmuxdClient] Proxy socket buffer full for connectionId: ${connectionId}`)
                }
              } else {
                console.warn(`[UsbmuxdClient] PlistPacket payload format unclear, skipping`)
              }
            } else {
              console.warn(`[UsbmuxdClient] PlistPacket payload too short (${message.payload.length} bytes)`)
            }
          }
        } else {
          // 自定义服务连接：直接转发原始数据，不进行 lockdownd 格式转换
          console.log(`[UsbmuxdClient] Custom service connection, forwarding raw data (${message.payload.length} bytes)`)
          const pushed = proxySocket.push(message.payload)
          if (pushed) {
            console.log(`[UsbmuxdClient] ✅ Forwarded ${message.payload.length} bytes to custom service`)
          } else {
            console.warn(`[UsbmuxdClient] Proxy socket buffer full for connectionId: ${connectionId}`)
          }
        }
      } else {
        console.log(`[UsbmuxdClient] No pending request for tag=${message.tag}, treating as async message`)
        // 可能是异步消息（如设备连接/断开）
        this.handleAsyncMessage(message)
      }
    }
  }

  /**
   * 解析消息
   */
  private parseMessage(buffer: Buffer): UsbmuxdMessage {
    if (buffer.length < 16) {
      throw new Error('Message too short')
    }

    const length = buffer.readUInt32LE(0)
    const version = buffer.readUInt32LE(4)
    const message = buffer.readUInt32LE(8)
    const tag = buffer.readUInt32LE(12)
    const payload = buffer.slice(16, length)

    // 调试：检查消息格式
    if (length !== buffer.length) {
      console.warn(`[UsbmuxdClient] Message length mismatch: declared=${length}, actual=${buffer.length}`)
    }

    return {
      version,
      message,
      tag,
      payload
    }
  }

  /**
   * 处理异步消息（如设备连接/断开）
   */
  private handleAsyncMessage(message: UsbmuxdMessage): void {
    if (message.message === UsbmuxdMessageType.Add) {
      console.log('[UsbmuxdClient] Device added')
    } else if (message.message === UsbmuxdMessageType.Remove) {
      console.log('[UsbmuxdClient] Device removed')
    }
  }

  /**
   * 序列化消息
   * @param message 消息类型
   * @param payload payload 数据
   * @param tag 消息 tag（由调用方提供）
   */
  private serializeMessage(message: number, payload: Buffer, tag: number): Buffer {
    const length = 16 + payload.length

    const header = Buffer.alloc(16)
    header.writeUInt32LE(length, 0) // 总长度
    header.writeUInt32LE(1, 4) // version = 1
    header.writeUInt32LE(message, 8) // message type
    header.writeUInt32LE(tag, 12) // tag

    const buffer = Buffer.concat([header, payload])
    console.log(`[UsbmuxdClient] Sending message: type=${message}, tag=${tag}, length=${length}, payload length=${payload.length}`)
    return buffer
  }

  /**
   * 发送消息并等待响应
   */
  private async sendMessage(message: number, payload: Buffer, timeout: number = 5000): Promise<UsbmuxdMessage> {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to usbmuxd')
    }

    const tag = ++this.tagCounter
    const buffer = this.serializeMessage(message, payload, tag)

    return new Promise((resolve, reject) => {
      let resolved = false
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.pendingRequests.delete(tag)
          reject(new Error('Request timeout'))
        }
      }, timeout)

      this.pendingRequests.set(tag, {
        resolve: (response) => {
          if (!resolved) {
            resolved = true
            clearTimeout(timer)
            resolve(response)
          }
        },
        reject: (error) => {
          if (!resolved) {
            resolved = true
            clearTimeout(timer)
            reject(error)
          }
        }
      })

      this.socket!.write(buffer, (error) => {
        if (error && !resolved) {
          resolved = true
          clearTimeout(timer)
          this.pendingRequests.delete(tag)
          reject(error)
        }
      })
    })
  }

  /**
   * 列出连接的设备
   */
  async listDevices(): Promise<UsbmuxdDevice[]> {
    console.log('[UsbmuxdClient] Listing devices...')

    // ListDevices 消息的 payload 是空的 plist
    // 注意：某些版本的 usbmuxd 可能需要使用 PlistPacket (8) 而不是 ListDevices (9)
    // 我们先尝试 ListDevices (9)
    const payload = Buffer.from(plist.build({}))

    try {
      // 增加超时时间到 10 秒
      console.log(`[UsbmuxdClient] Sending ListDevices request with tag=${this.tagCounter + 1}`)
      const response = await this.sendMessage(UsbmuxdMessageType.ListDevices, payload, 10000)
      
      console.log(`[UsbmuxdClient] ✅ Received response: type=${response.message}, tag=${response.tag}, payload length=${response.payload.length}`)
      
      // 解析响应（plist 格式）
      // 响应可能是 PlistPacket (8) 类型
      let plistData: any
      try {
        const payloadStr = response.payload.toString('utf-8')
        console.log(`[UsbmuxdClient] Payload string length: ${payloadStr.length}`)
        plistData = plist.parse(payloadStr)
        console.log('[UsbmuxdClient] Parsed plist:', JSON.stringify(plistData, null, 2))
        console.log('[UsbmuxdClient] Parsed plist keys:', Object.keys(plistData || {}))
      } catch (parseError) {
        console.error('[UsbmuxdClient] Failed to parse plist:', parseError)
        console.error('[UsbmuxdClient] Raw payload (first 200 chars):', response.payload.toString('utf-8').substring(0, 200))
        throw new Error('Failed to parse response plist')
      }
      
      // 检查响应类型
      if (plistData && plistData.MessageType) {
        console.log(`[UsbmuxdClient] Response MessageType: ${plistData.MessageType}`)
        
        // 如果是错误响应
        if (plistData.MessageType === 'Result' && plistData.Number !== undefined) {
          console.log(`[UsbmuxdClient] Result code: ${plistData.Number}`)
          if (plistData.Number !== 0) {
            // 错误码不为 0，使用 fallback
            console.log(`[UsbmuxdClient] usbmuxd returned error code ${plistData.Number}, using fallback...`)
            return this.fallbackToCommandLineTools()
          }
        }
      }
      
      // 查找设备列表
      if (plistData && plistData.DeviceList) {
        const devices = Array.isArray(plistData.DeviceList) 
          ? plistData.DeviceList 
          : [plistData.DeviceList]
        
        console.log(`[UsbmuxdClient] ✅ Found ${devices.length} device(s)`)
        return devices
      } else {
        // 如果没有 DeviceList，可能是空响应或者需要不同的处理
        // 某些版本的 usbmuxd 可能返回不同的格式
        console.log('[UsbmuxdClient] No DeviceList in response')
        console.log('[UsbmuxdClient] Full response:', JSON.stringify(plistData, null, 2))
        
        // 尝试使用命令行工具作为 fallback
        return this.fallbackToCommandLineTools()
      }
    } catch (error) {
      console.error('[UsbmuxdClient] ❌ Failed to list devices:', error)
      // 如果 ListDevices (9) 失败，尝试使用 PlistPacket (8)
      if (error instanceof Error && error.message.includes('timeout')) {
        console.log('[UsbmuxdClient] Trying PlistPacket (8) instead of ListDevices (9)...')
        try {
          const plistPayload = Buffer.from(plist.build({ MessageType: 'ListDevices' }))
          const response = await this.sendMessage(UsbmuxdMessageType.PlistPacket, plistPayload, 10000)
          const plistData = plist.parse(response.payload.toString('utf-8')) as any
          
          if (plistData && plistData.DeviceList) {
            const devices = Array.isArray(plistData.DeviceList) 
              ? plistData.DeviceList 
              : [plistData.DeviceList]
            console.log(`[UsbmuxdClient] ✅ Found ${devices.length} device(s) using PlistPacket`)
            return devices
          }
        } catch (fallbackError) {
          console.error('[UsbmuxdClient] PlistPacket also failed:', fallbackError)
        }
      }
      throw error
    }
  }

  /**
   * 连接到设备的指定端口
   */
  async connectToDevice(udid: string, port: number): Promise<Socket> {
    console.log(`[UsbmuxdClient] Connecting to device ${udid} on port ${port}...`)
    console.log(`[UsbmuxdClient] Note: This requires:`)
    console.log(`[UsbmuxdClient]   1. iOS Companion Service app running in foreground`)
    console.log(`[UsbmuxdClient]   2. Developer Disk Image mounted (Xcode connected)`)
    console.log(`[UsbmuxdClient]   3. App listening on port ${port}`)

    // 首先获取设备 ID
    const devices = await this.listDevices()
    const device = devices.find(d => d.Properties?.SerialNumber === udid)
    
    if (!device) {
      throw new Error(`Device ${udid} not found`)
    }

    const deviceId = device.DeviceID
    console.log(`[UsbmuxdClient] Found device ID: ${deviceId} for UDID: ${udid}`)

    // Connect 消息的 payload
    // PortNumber 需要字节序转换（大端序，类似 htons）
    // 例如：12345 (0x3039) -> 0x3930 (大端序)
    const portNumber = ((port & 0xFF) << 8) | ((port >> 8) & 0xFF)
    console.log(`[UsbmuxdClient] Port conversion: ${port} (0x${port.toString(16)}) -> ${portNumber} (0x${portNumber.toString(16)})`)
    
    const payload = Buffer.from(plist.build({
      DeviceID: deviceId,
      PortNumber: portNumber
    }))

    console.log(`[UsbmuxdClient] Sending Connect message: DeviceID=${deviceId}, PortNumber=${portNumber} (port ${port})`)

    try {
      const response = await this.sendMessage(UsbmuxdMessageType.Connect, payload)
      
      // 检查响应
      const plistData = plist.parse(response.payload.toString('utf-8')) as any
      
      console.log(`[UsbmuxdClient] Connect response:`, JSON.stringify(plistData, null, 2))
      
      // 检查错误
      if (plistData && plistData.Error) {
        console.error(`[UsbmuxdClient] ❌ Connection error: ${plistData.Error}`)
        throw new Error(`Connection failed: ${plistData.Error}`)
      }
      
      // 检查 Result 消息的错误代码
      if (plistData && plistData.MessageType === 'Result' && plistData.Number !== undefined && plistData.Number !== 0) {
        const errorCode = plistData.Number
        const errorMsg = plistData.Error || `usbmuxd error code ${errorCode}`
        
        console.error(`[UsbmuxdClient] ❌ Connection failed with error code: ${errorCode}`)
        console.error(`[UsbmuxdClient] Error message: ${errorMsg}`)
        
        // 提供详细的错误诊断
        if (errorCode === 1) {
          console.error(`[UsbmuxdClient] Error code 1 = Connection refused`)
          console.error(`[UsbmuxdClient] Possible causes:`)
          console.error(`[UsbmuxdClient]   1. iOS Companion Service app is not running`)
          console.error(`[UsbmuxdClient]   2. App is not in foreground (iOS may suspend background apps)`)
          console.error(`[UsbmuxdClient]   3. App is not listening on port ${port}`)
          console.error(`[UsbmuxdClient]   4. Developer Disk Image not mounted (check: ideviceinfo | grep Developer)`)
          console.error(`[UsbmuxdClient]   5. Port ${port} is blocked by iOS security`)
        }
        
        throw new Error(`Connection failed: ${errorMsg}`)
      }

      // Connect 成功后，usbmuxd 会通过同一个 socket 传输数据
      // 我们需要创建一个代理 Socket，通过 Packet 消息类型转发数据
      const connectionId = ++this.connectionIdCounter
      
      // 创建一个自定义的 Duplex stream 作为代理 Socket
      const usbmuxdClient = this // 保存 this 引用
      const proxySocket = new Duplex({
        objectMode: false,
        allowHalfOpen: false,
        read() {
          // 数据通过 push 从外部推送（从 usbmuxd 接收的 Packet 消息）
        },
        write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
          console.log(`[UsbmuxdClient] Proxy socket write: connectionId=${connectionId}, data length=${data.length}`)
          
          if (usbmuxdClient.socket && usbmuxdClient.connected) {
            usbmuxdClient.sendPacketMessage(connectionId, data)
            callback()
          } else {
            console.error(`[UsbmuxdClient] Cannot send packet: socket=${!!usbmuxdClient.socket}, connected=${usbmuxdClient.connected}`)
            callback(new Error('Not connected'))
          }
        }
      }) as any
      
      // 让 proxySocket 表现得像一个 Socket
      proxySocket.setNoDelay = () => {}
      
      // 保存原始的 destroy 方法，避免递归调用
      const originalDestroy = proxySocket.destroy.bind(proxySocket)
      proxySocket.destroy = () => {
        this.deviceConnections.delete(connectionId)
        this.connectionTypes.delete(connectionId)
        // 调用原始的 destroy 方法，而不是自己
        originalDestroy()
      }
      
      proxySocket.readyState = 'open'
      proxySocket.writable = true
      proxySocket.readable = true
      
      proxySocket.on('close', () => {
        this.deviceConnections.delete(connectionId)
        this.connectionTypes.delete(connectionId)
      })
      
      proxySocket.on('error', (error: Error) => {
        console.error(`[UsbmuxdClient] Proxy socket error (connectionId: ${connectionId}):`, error)
      })
      
      // 存储连接映射
      this.deviceConnections.set(connectionId, proxySocket)
      
      // 判断连接类型：lockdownd 使用端口 62078，其他端口为自定义服务
      // 注意：这个判断可能不准确，但 lockdownd 通常使用固定端口
      const connectionType: 'lockdownd' | 'custom' = (port === 62078 || port === 0) ? 'lockdownd' : 'custom'
      this.connectionTypes.set(connectionId, connectionType)
      console.log(`[UsbmuxdClient] Connection type: ${connectionType} (port: ${port})`)
      
      // 立即标记为已连接
      setImmediate(() => {
        proxySocket.emit('connect')
      })
      
      console.log(`[UsbmuxdClient] ✅ Connected to device ${udid} on port ${port} (connectionId: ${connectionId})`)
      return proxySocket
    } catch (error) {
      console.error(`[UsbmuxdClient] ❌ Failed to connect to device:`, error)
      throw error
    }
  }

  /**
   * 发送 Packet 消息到设备
   * 
   * Packet 消息格式：
   * - 消息头：16 字节（长度、版本、消息类型、tag）
   * - Payload：connectionId (4字节) + 数据
   */
  private sendPacketMessage(connectionId: number, data: Buffer): void {
    if (!this.socket || !this.connected) {
      console.error('[UsbmuxdClient] Cannot send packet: not connected')
      return
    }

    console.log(`[UsbmuxdClient] Sending packet: connectionId=${connectionId}, data length=${data.length}`)

    // Packet 消息格式：消息头 (16字节) + payload (connectionId 4字节 + 数据)
    const payload = Buffer.concat([
      Buffer.alloc(4),
      data
    ])
    payload.writeUInt32LE(connectionId, 0) // connectionId 在 payload 开头

    const totalLength = 16 + payload.length
    const header = Buffer.alloc(16)
    header.writeUInt32LE(totalLength, 0) // 总长度
    header.writeUInt32LE(1, 4) // version
    header.writeUInt32LE(UsbmuxdMessageType.Packet, 8) // message type
    header.writeUInt32LE(0, 12) // tag (Packet 消息通常使用 0)

    const packet = Buffer.concat([header, payload])
    this.socket.write(packet, (error) => {
      if (error) {
        console.error(`[UsbmuxdClient] Failed to send packet:`, error)
      } else {
        console.log(`[UsbmuxdClient] ✅ Packet sent: connectionId=${connectionId}, total length=${packet.length}`)
      }
    })
  }

  /**
   * 处理接收到的 Packet 消息
   */
  private handlePacketMessage(message: UsbmuxdMessage): void {
    if (message.payload.length < 4) {
      console.warn('[UsbmuxdClient] Packet message too short')
      return
    }

    // 读取 connectionId（前 4 字节）
    const connectionId = message.payload.readUInt32LE(0)
    // 提取实际数据（去掉 connectionId 前缀）
    const data = message.payload.slice(4)

    console.log(`[UsbmuxdClient] Received packet: connectionId=${connectionId}, payload length=${message.payload.length}, data length=${data.length}`)
    console.log(`[UsbmuxdClient] Available connectionIds: ${Array.from(this.deviceConnections.keys()).join(', ')}`)
    
    // 调试：打印前几个字节的十六进制，确认数据格式
    if (data.length > 0) {
      const preview = data.slice(0, Math.min(16, data.length))
      console.log(`[UsbmuxdClient] Data preview (hex): ${preview.toString('hex')}`)
    }

    // 转发到对应的代理 socket
    const proxySocket = this.deviceConnections.get(connectionId)
    if (proxySocket) {
      console.log(`[UsbmuxdClient] Forwarding ${data.length} bytes to proxy socket (connectionId: ${connectionId})`)
      console.log(`[UsbmuxdClient] Proxy socket type: ${proxySocket.constructor.name}`)
      console.log(`[UsbmuxdClient] Proxy socket listeners: data=${proxySocket.listenerCount('data')}, readable=${proxySocket.listenerCount('readable')}`)
      
      // 直接触发 data 事件（这是最可靠的方式）
      // Duplex stream 的 push 可能不会立即触发 data 事件，所以直接 emit
      const listenerCount = proxySocket.listenerCount('data')
      console.log(`[UsbmuxdClient] Proxy socket has ${listenerCount} data listener(s)`)
      
      // 只使用 push()，Duplex stream 会自动触发 'data' 事件
      // 不要同时使用 emit('data')，避免重复处理
      const pushed = proxySocket.push(data)
      if (!pushed) {
        console.warn(`[UsbmuxdClient] Proxy socket buffer full for connectionId: ${connectionId}, pausing`)
        // 如果缓冲区满了，暂停读取
        this.socket?.pause()
        proxySocket.once('drain', () => {
          this.socket?.resume()
          console.log(`[UsbmuxdClient] Proxy socket drained, resuming`)
        })
      } else {
        console.log(`[UsbmuxdClient] ✅ Pushed ${data.length} bytes to Duplex stream (connectionId: ${connectionId})`)
      }
    } else {
      console.warn(`[UsbmuxdClient] No proxy socket found for connectionId: ${connectionId}`)
      console.warn(`[UsbmuxdClient] Available connectionIds: ${Array.from(this.deviceConnections.keys()).join(', ')}`)
    }
  }

  /**
   * 使用命令行工具作为 fallback（idevice_id 或 go-ios）
   */
  private fallbackToCommandLineTools(): Promise<UsbmuxdDevice[]> {
    return new Promise((resolve) => {
      // 先尝试 idevice_id
      console.log('[UsbmuxdClient] Trying to use idevice_id as fallback...')
      const proc = spawn('idevice_id', ['-l'], {
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
        if (code === 0 && stdout.trim()) {
          const udids = stdout.trim().split('\n').filter(udid => udid.trim())
          console.log(`[UsbmuxdClient] ✅ Found ${udids.length} device(s) via idevice_id`)
          // 转换为 UsbmuxdDevice 格式
          const devices: UsbmuxdDevice[] = udids.map((udid, index) => ({
            DeviceID: index + 1,
            MessageType: 'Attached',
            Properties: {
              SerialNumber: udid.trim(),
              ConnectionSpeed: 480000000,
              ConnectionType: 'USB',
              DeviceID: index + 1,
              LocationID: 0,
              ProductID: 0
            }
          }))
          resolve(devices)
        } else {
          console.log('[UsbmuxdClient] idevice_id fallback failed, trying go-ios...')
          // 尝试 go-ios
          this.tryGoIOSFallback(resolve)
        }
      })
      
      proc.on('error', () => {
        console.log('[UsbmuxdClient] idevice_id not available, trying go-ios...')
        this.tryGoIOSFallback(resolve)
      })
    })
  }

  /**
   * 使用 go-ios 作为 fallback
   */
  private tryGoIOSFallback(resolve: (devices: UsbmuxdDevice[]) => void): void {
    try {
      // go-ios 命令路径
      const iosCommandPath = path.join(process.cwd(), 'commands', 'ios')
      
      if (!fs.existsSync(iosCommandPath)) {
        console.log('[UsbmuxdClient] go-ios not found, returning empty list')
        resolve([])
        return
      }
      
      const proc = spawn(iosCommandPath, ['list'], {
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
        if (code === 0) {
          try {
            const data = JSON.parse(stdout.trim())
            const deviceList = data.deviceList || []
            
            if (Array.isArray(deviceList) && deviceList.length > 0) {
              console.log(`[UsbmuxdClient] ✅ Found ${deviceList.length} device(s) via go-ios`)
              const devices: UsbmuxdDevice[] = deviceList.map((udid: string, index: number) => ({
                DeviceID: index + 1,
                MessageType: 'Attached',
                Properties: {
                  SerialNumber: String(udid),
                  ConnectionSpeed: 480000000,
                  ConnectionType: 'USB',
                  DeviceID: index + 1,
                  LocationID: 0,
                  ProductID: 0
                }
              }))
              resolve(devices)
            } else {
              resolve([])
            }
          } catch (error) {
            console.error('[UsbmuxdClient] Failed to parse go-ios output:', error)
            resolve([])
          }
        } else {
          console.log('[UsbmuxdClient] go-ios failed, returning empty list')
          resolve([])
        }
      })
      
      proc.on('error', () => {
        console.log('[UsbmuxdClient] go-ios not available, returning empty list')
        resolve([])
      })
    } catch (error) {
      console.error('[UsbmuxdClient] go-ios fallback error:', error)
      resolve([])
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
      this.connected = false
      this.dataBuffer = Buffer.alloc(0)
      this.pendingRequests.clear()
      console.log('[UsbmuxdClient] Disconnected')
    }
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.connected && this.socket !== null
  }
}
