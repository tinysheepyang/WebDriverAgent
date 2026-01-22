/**
 * Photo Proxy HTTP 服务器
 */

import http from 'node:http'
import url from 'node:url'
import type { ParsedUrlQuery } from 'node:querystring'
import { DeviceManager } from './usb/device.js'
import { PhotosService } from './usb/service.js'
import { AlbumsManager } from './photos/albums.js'
import { AssetsManager } from './photos/assets.js'
import { ThumbnailManager } from './photos/thumbnail.js'
import { MemoryCache } from './cache/memory.js'
import { DiskCache } from './cache/disk.js'
import type { PhotoProxyConfig } from './types.js'

export class PhotoProxyServer {
  private server: http.Server | null = null
  private port: number
  private deviceManager: DeviceManager
  private photosService: PhotosService
  private albumsManager: AlbumsManager
  private assetsManager: AssetsManager
  private thumbnailManager: ThumbnailManager
  private memoryCache: MemoryCache
  private diskCache: DiskCache

  constructor(config: PhotoProxyConfig = {}) {
    this.port = config.port || 9001 // 使用 9001，避免与 PTP 服务（9000）冲突
    this.deviceManager = new DeviceManager()
    this.photosService = new PhotosService()
    this.memoryCache = new MemoryCache(config.memoryCacheTTL)
    this.diskCache = new DiskCache(config.cacheDir)
    this.albumsManager = new AlbumsManager(this.photosService)
    this.assetsManager = new AssetsManager(this.photosService)
    this.thumbnailManager = new ThumbnailManager(
      this.photosService,
      this.memoryCache,
      this.diskCache
    )

    // 定期清理过期缓存
    setInterval(() => {
      this.memoryCache.cleanup()
    }, 5 * 60 * 1000) // 每 5 分钟清理一次
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[PhotoProxy] Starting server on port ${this.port}...`)
      
      this.server = http.createServer((req, res) => {
        const startTime = Date.now()
        const method = req.method || 'GET'
        const url = req.url || '/'
        console.log(`[PhotoProxy] ${method} ${url}`)
        
        this.handleRequest(req, res).then(() => {
          const duration = Date.now() - startTime
          console.log(`[PhotoProxy] ${method} ${url} - ${res.statusCode} (${duration}ms)`)
        }).catch((error) => {
          const duration = Date.now() - startTime
          console.error(`[PhotoProxy] ${method} ${url} - Error (${duration}ms):`, error)
        })
      })

      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[PhotoProxy] ✅ Server started on http://127.0.0.1:${this.port}`)
        console.log(`[PhotoProxy] Ready to accept requests`)
        resolve()
      })

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`[PhotoProxy] ❌ Port ${this.port} is already in use`)
          console.error('[PhotoProxy] 可能的原因：')
          console.error('  1. 之前的 photo-proxy 进程还在运行')
          console.error('  2. 其他程序占用了 9001 端口')
          console.error('[PhotoProxy] 解决方案：')
          console.error(`  - 运行: lsof -ti:${this.port} | xargs kill -9`)
          console.error(`  - 或者: killall -9 node (谨慎使用)`)
        } else {
          console.error('[PhotoProxy] ❌ Server error:', error)
        }
        reject(error)
      })
    })
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[PhotoProxy] Server stopped')
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  /**
   * 处理 HTTP 请求
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS 支持
    this.setCorsHeaders(res)

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const parsedUrl = url.parse(req.url || '', true)
    const pathname = parsedUrl.pathname || ''
    const method = req.method || 'GET'

    try {
      // 路由处理（按照新的接口定义）
      if (method === 'GET' && pathname === '/photos/assets') {
        // GET /photos/assets?limit=200&offset=0
        await this.handleGetAssets(req, res, parsedUrl.query)
      } else if (method === 'GET' && pathname.startsWith('/photos/asset/') && pathname.endsWith('/thumbnail')) {
        // GET /photos/asset/{assetId}/thumbnail?size=320
        const assetId = pathname.split('/')[3]
        await this.handleGetThumbnail(req, res, assetId, parsedUrl.query)
      } else if (method === 'GET' && pathname.startsWith('/photos/asset/') && pathname.endsWith('/image')) {
        // GET /photos/asset/{assetId}/image?quality=full&format=jpeg
        const assetId = pathname.split('/')[3]
        await this.handleGetAssetImage(req, res, assetId, parsedUrl.query)
      } else if (method === 'GET' && pathname.startsWith('/photos/asset/') && pathname.endsWith('/video/stream')) {
        // GET /photos/asset/{assetId}/video/stream
        const assetId = pathname.split('/')[3]
        await this.handleGetAssetVideoStream(req, res, assetId)
      } else if (method === 'GET' && pathname === '/health') {
        await this.handleHealth(req, res)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    } catch (error) {
      console.error('[PhotoProxy] Request error:', error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(error) }))
    }
  }

  /**
   * 设置 CORS 头
   */
  private setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  /**
   * GET /photos/assets?limit=200&offset=0
   * 
   * 返回所有资源列表（不分相册）
   * 这是 Phase 1 的核心接口，替代 DCIM 目录遍历
   */
  private async handleGetAssets(req: http.IncomingMessage, res: http.ServerResponse, query: ParsedUrlQuery): Promise<void> {
    try {
      const limit = query.limit ? parseInt(query.limit as string, 10) : 200
      const offset = query.offset ? parseInt(query.offset as string, 10) : 0

      console.log(`[PhotoProxy] GET /photos/assets?limit=${limit}&offset=${offset}`)

      // 尝试获取设备
      const device = await this.deviceManager.getFirstDevice()
      if (!device) {
        // 没有设备连接，返回空列表（前端会 fallback 到 PTP）
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ total: 0, items: [] }))
        return
      }

      this.photosService.setDevice(device)
      
      // 通过 Photos Service 获取资源列表
      const assets = await this.assetsManager.getAllAssets(limit, offset)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(assets))
    } catch (error) {
      console.error('[PhotoProxy] handleGetAssets error:', error)
      // 发生错误时，返回空列表而不是 500，让前端可以 fallback
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ total: 0, items: [] }))
    }
  }

  /**
   * GET /photos/asset/{assetId}/thumbnail?size=320
   * 
   * 获取缩略图（Grid 必需）
   * - 返回 JPEG 二进制，≤ 30KB
   * - 失败返回 204，前端 fallback
   */
  private async handleGetThumbnail(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    assetId: string,
    query: ParsedUrlQuery
  ): Promise<void> {
    const startTime = Date.now()
    try {
      const size = query.size ? parseInt(query.size as string, 10) : 320

      console.log(`[PhotoProxy] GET /photos/asset/${assetId}/thumbnail?size=${size}`)

      if (!assetId) {
        console.error('[PhotoProxy] ❌ Missing assetId parameter')
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing assetId parameter' }))
        return
      }

      const device = await this.deviceManager.getFirstDevice()
      if (!device) {
        // 没有设备连接，返回 204（前端会 fallback 到 PTP）
        res.writeHead(204)
        res.end()
        return
      }

      console.log(`[PhotoProxy] Device found: ${device.udid}`)
      this.photosService.setDevice(device)
      
      const thumbnail = await this.thumbnailManager.getThumbnail({ assetId, size })

      if (!thumbnail) {
        console.log(`[PhotoProxy] ⚠️ Thumbnail not available for assetId: ${assetId}, returning 204`)
        // 返回 204 No Content，表示缩略图不可用（前端会 fallback 到 PTP）
        res.writeHead(204)
        res.end()
        return
      }

      const duration = Date.now() - startTime
      console.log(`[PhotoProxy] ✅ Thumbnail retrieved: assetId=${assetId}, size=${thumbnail.length} bytes, duration=${duration}ms`)

      // 验证大小（≤ 30KB）
      if (thumbnail.length > 30 * 1024) {
        console.warn(`[PhotoProxy] ⚠️ Thumbnail too large: ${thumbnail.length} bytes, expected ≤ 30KB`)
      }

      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=3600',
        'Content-Length': thumbnail.length.toString()
      })
      res.end(thumbnail)
    } catch (error) {
      const duration = Date.now() - startTime
      console.error(`[PhotoProxy] ❌ Error getting thumbnail: ${error}, duration=${duration}ms`)
      // 发生错误时，返回 204 而不是 500，让前端可以 fallback
      res.writeHead(204)
      res.end()
    }
  }

  /**
   * GET /photos/asset/{assetId}/image?quality=full&format=jpeg
   * 
   * 图片查看（点击）
   * - quality: full | screen（full=原图, screen=屏幕尺寸）
   * - format: jpeg | heic（输出格式）
   * - 返回：完整图片（JPEG 或 HEIC）
   * 
   * iOS 端实现：
   * requestImageDataAndOrientationForAsset
   */
  private async handleGetAssetImage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    assetId: string,
    query: ParsedUrlQuery
  ): Promise<void> {
    const startTime = Date.now()
    try {
      const quality = (query.quality as string) || 'full' // full | screen
      const format = (query.format as string) || 'jpeg' // jpeg | heic
      
      console.log(`[PhotoProxy] GET /photos/asset/${assetId}/image?quality=${quality}&format=${format}`)

      if (!assetId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing assetId' }))
        return
      }

      const device = await this.deviceManager.getFirstDevice()
      if (!device) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No device connected' }))
        return
      }

      this.photosService.setDevice(device)
      
      // 通过 Photos Service 获取图片流
      const imageStream = await this.photosService.getImage(assetId, quality as 'full' | 'screen')
      
      // 设置 Content-Type
      const contentType = format === 'heic' ? 'image/heic' : 'image/jpeg'
      
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked'
      })
      
      // 流式传输
      imageStream.on('data', (chunk: Buffer) => {
        res.write(chunk)
      })
      
      imageStream.on('end', () => {
        const duration = Date.now() - startTime
        console.log(`[PhotoProxy] ✅ Image stream completed: assetId=${assetId}, duration=${duration}ms`)
        res.end()
      })
      
      imageStream.on('error', (error: Error) => {
        const duration = Date.now() - startTime
        console.error(`[PhotoProxy] ❌ Image stream error: ${error}, duration=${duration}ms`)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(error) }))
        } else {
          res.end()
        }
      })
    } catch (error) {
      const duration = Date.now() - startTime
      console.error(`[PhotoProxy] ❌ Error getting asset image: ${error}, duration=${duration}ms`)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      }
    }
  }

  /**
   * GET /photos/asset/{assetId}/video/stream
   * 
   * 视频流（点击播放）
   * - Content-Type: video/mp4
   * - Transfer-Encoding: chunked
   * - 边读边发（Phase 1 不支持 seek）
   * 
   * iOS 端实现：
   * requestAVAssetForVideo -> AVURLAsset -> NSInputStream -> streamToPC
   */
  private async handleGetAssetVideoStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    assetId: string
  ): Promise<void> {
    const startTime = Date.now()
    try {
      console.log(`[PhotoProxy] GET /photos/asset/${assetId}/video/stream`)

      if (!assetId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing assetId' }))
        return
      }

      const device = await this.deviceManager.getFirstDevice()
      if (!device) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No device connected' }))
        return
      }

      this.photosService.setDevice(device)
      
      // 通过 Photos Service 获取视频流
      const videoStream = await this.photosService.getVideoStream(assetId)
      
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked'
      })
      
      // 流式传输
      videoStream.on('data', (chunk: Buffer) => {
        res.write(chunk)
      })
      
      videoStream.on('end', () => {
        const duration = Date.now() - startTime
        console.log(`[PhotoProxy] ✅ Video stream completed: assetId=${assetId}, duration=${duration}ms`)
        res.end()
      })
      
      videoStream.on('error', (error: Error) => {
        const duration = Date.now() - startTime
        console.error(`[PhotoProxy] ❌ Video stream error: ${error}, duration=${duration}ms`)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(error) }))
        } else {
          res.end()
        }
      })
    } catch (error) {
      const duration = Date.now() - startTime
      console.error(`[PhotoProxy] ❌ Error getting asset video stream: ${error}, duration=${duration}ms`)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      }
    }
  }

  /**
   * GET /health
   */
  private async handleHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', port: this.port }))
  }
}
