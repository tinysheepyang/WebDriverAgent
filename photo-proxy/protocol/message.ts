/**
 * iOS Companion Service 消息协议
 * 
 * 协议格式（自定义 framing）：
 * [消息头: 8 字节][JSON 请求/响应][二进制数据（可选）]
 * 
 * 消息头格式：
 * - 4 字节：消息类型（uint32，大端序）
 * - 4 字节：JSON 长度（uint32，大端序）
 * 
 * 消息类型：
 * - 1: LIST_ASSETS
 * - 2: GET_THUMBNAIL
 * - 3: GET_IMAGE
 * - 4: GET_VIDEO_STREAM
 * - 100: RESPONSE_SUCCESS
 * - 101: RESPONSE_ERROR
 */

export enum MessageType {
  // 请求类型
  LIST_ASSETS = 1,
  GET_THUMBNAIL = 2,
  GET_IMAGE = 3,
  GET_VIDEO_STREAM = 4,
  OPEN_URL = 5,     // 打开 URL（通过 WKWebView）
  AUTO_LOGIN = 6,   // 测试版自动登录
  HTTP_REQUEST = 7, // 设备侧发起 HTTP 请求并回传结果
  
  // 响应类型
  RESPONSE_SUCCESS = 100,
  RESPONSE_ERROR = 101,
  
  // 流式数据
  STREAM_CHUNK = 200,
  STREAM_END = 201
}

export interface Message {
  type: MessageType
  payload: any // JSON 对象
  binaryData?: Buffer // 可选的二进制数据
}

export interface ListAssetsRequest {
  limit: number
  offset: number
}

export interface ListAssetsResponse {
  total: number
  items: Array<{
    assetId: string
    type: 'image' | 'video'
    subtype?: string[]
    width: number
    height: number
    duration?: number
    creationTime: number
  }>
}

export interface GetThumbnailRequest {
  assetId: string
  size: number
}

export interface GetImageRequest {
  assetId: string
  quality: 'full' | 'screen'
  format: 'jpeg' | 'heic'
}

export interface GetVideoStreamRequest {
  assetId: string
}

export interface OpenURLRequest {
  url: string
}

export interface ErrorResponse {
  error: string
  code?: number
}

/**
 * 消息序列化
 */
export class MessageSerializer {
  /**
   * 序列化消息为 Buffer
   */
  static serialize(message: Message): Buffer {
    const jsonPayload = JSON.stringify(message.payload)
    const jsonBuffer = Buffer.from(jsonPayload, 'utf-8')
    
    // 消息头：8 字节
    const header = Buffer.alloc(8)
    header.writeUInt32BE(message.type, 0) // 消息类型（大端序）
    header.writeUInt32BE(jsonBuffer.length, 4) // JSON 长度（大端序）
    
    // 如果有二进制数据，追加到 JSON 后面
    if (message.binaryData) {
      return Buffer.concat([header, jsonBuffer, message.binaryData])
    } else {
      return Buffer.concat([header, jsonBuffer])
    }
  }
  
  /**
   * 反序列化 Buffer 为消息
   */
  static deserialize(buffer: Buffer): Message {
    if (buffer.length < 8) {
      throw new Error('Message too short')
    }
    
    // 读取消息头
    const type = buffer.readUInt32BE(0) as MessageType
    const jsonLength = buffer.readUInt32BE(4)
    
    if (buffer.length < 8 + jsonLength) {
      throw new Error('Incomplete message')
    }
    
    // 读取 JSON payload
    const jsonBuffer = buffer.slice(8, 8 + jsonLength)
    const payload = JSON.parse(jsonBuffer.toString('utf-8'))
    
    // 读取二进制数据（如果有）
    const binaryData = buffer.length > 8 + jsonLength
      ? buffer.slice(8 + jsonLength)
      : undefined
    
    return {
      type,
      payload,
      binaryData
    }
  }
}
