/**
 * USB 二进制协议帧格式
 * 
 * 基于爱思助手级别的真实实现
 * 
 * 帧结构（固定）：
 * struct FrameHeader {
 *   uint32_t magic;       // 0x50484F54 = "PHOT"
 *   uint16_t version;     // 1
 *   uint16_t type;        // Request / Response / Push
 *   uint32_t requestId;
 *   uint32_t payloadLen;
 * };
 * 
 * payload 紧随其后
 */

export enum FrameType {
  LIST_ASSETS = 1,
  GET_THUMB = 2,
  GET_IMAGE = 3,
  GET_VIDEO = 4,
  OPEN_URL = 5,
  AUTO_LOGIN = 6,
  HTTP_REQUEST = 7,
  DATA = 100,
  ERROR = 500
}

export interface FrameHeader {
  magic: number        // 0x50484F54 = "PHOT"
  version: number      // 1
  type: FrameType
  requestId: number
  payloadLen: number
}

export interface Frame {
  header: FrameHeader
  payload: Buffer
}

export class FrameSerializer {
  private static readonly MAGIC = 0x50484F54 // "PHOT"
  private static readonly VERSION = 1
  private static readonly HEADER_SIZE = 16 // 4 + 2 + 2 + 4 + 4

  /**
   * 序列化帧
   */
  static serialize(type: FrameType, requestId: number, payload: Buffer | string): Buffer {
    const payloadBuffer = typeof payload === 'string' 
      ? Buffer.from(payload, 'utf-8')
      : payload

    const header = Buffer.alloc(this.HEADER_SIZE)
    
    // magic (4 bytes, big endian)
    header.writeUInt32BE(this.MAGIC, 0)
    
    // version (2 bytes, big endian)
    header.writeUInt16BE(this.VERSION, 4)
    
    // type (2 bytes, big endian)
    header.writeUInt16BE(type, 6)
    
    // requestId (4 bytes, big endian)
    header.writeUInt32BE(requestId, 8)
    
    // payloadLen (4 bytes, big endian)
    header.writeUInt32BE(payloadBuffer.length, 12)

    return Buffer.concat([header, payloadBuffer])
  }

  /**
   * 反序列化帧头
   */
  static deserializeHeader(buffer: Buffer): FrameHeader | null {
    if (buffer.length < this.HEADER_SIZE) {
      return null // 数据不完整
    }

    const magic = buffer.readUInt32BE(0)
    if (magic !== this.MAGIC) {
      return null // 无效的 magic
    }

    const version = buffer.readUInt16BE(4)
    const type = buffer.readUInt16BE(6) as FrameType
    const requestId = buffer.readUInt32BE(8)
    const payloadLen = buffer.readUInt32BE(12)

    return {
      magic,
      version,
      type,
      requestId,
      payloadLen
    }
  }

  /**
   * 检查缓冲区是否包含完整的帧
   */
  static isFrameComplete(buffer: Buffer): boolean {
    if (buffer.length < this.HEADER_SIZE) {
      return false
    }

    const header = this.deserializeHeader(buffer)
    if (!header) {
      return false
    }

    const totalSize = this.HEADER_SIZE + header.payloadLen
    return buffer.length >= totalSize
  }

  /**
   * 从缓冲区提取帧
   */
  static extractFrame(buffer: Buffer): { frame: Frame | null; remaining: Buffer } {
    if (!this.isFrameComplete(buffer)) {
      return { frame: null, remaining: buffer }
    }

    const header = this.deserializeHeader(buffer)!
    const payload = buffer.slice(this.HEADER_SIZE, this.HEADER_SIZE + header.payloadLen)
    const remaining = buffer.slice(this.HEADER_SIZE + header.payloadLen)

    return {
      frame: {
        header,
        payload
      },
      remaining
    }
  }
}
