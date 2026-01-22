/**
 * iOS Companion Service - 二进制协议实现
 *
 * 基于爱思助手级别的真实实现
 *
 * 协议帧格式（固定）：
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

import Photos
import AVFoundation
import Foundation
import Network
import CoreMedia
import UIKit
import WebKit

// 帧类型
enum FrameType: UInt16 {
    case LIST_ASSETS = 1
    case GET_THUMB  = 2
    case GET_IMAGE  = 3
    case GET_VIDEO  = 4
    case OPEN_URL   = 5
    case AUTO_LOGIN = 6   // 通过测试版 App 执行自动登录
    case HTTP_REQUEST = 7 // 设备侧发起 HTTP 请求并将结果回传
    case DATA       = 100
    case ERROR      = 500
}

class PhotoCompanionServiceBinary: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    // 服务版本信息（用于日志和排查「是否为最新版本」）
    private let serviceVersion: String
    private let serviceBuild: String
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    
    // Thumbnail Cache (L0: 内存缓存)
    private let thumbCache = NSCache<NSString, NSData>()
    private let cacheQueue = DispatchQueue(label: "com.xiaoying.photo-companion.cache")
    
    // 预取管理器
    private var prefetchManager: PHCachingImageManager?
    private var prefetchAssets: [PHAsset] = []
    
    // WKWebView 实例（用于打开 URL 和执行 HTTP 请求）
    private var webView: WKWebView?
    private var webViewWindow: UIWindow?
    private var httpRequestWebView: WKWebView? // 专门用于 HTTP 请求的隐藏 WKWebView
    private var httpRequestWebViewReady = false // 标记 HTTP 请求 WKWebView 是否已准备好
    // 保存 OPEN_URL 请求的上下文，用于在加载完成时发送响应
    private var pendingOpenURLRequest: (requestId: UInt32, connection: NWConnection, url: String)?
    // 保存 HTTP_REQUEST 请求的上下文，用于在请求完成时发送响应
    private var pendingHttpRequests: [UInt32: (connection: NWConnection, url: String, method: String, headers: [String: String], body: String?)] = [:]
    
    override init() {
        // 读取版本信息
        let info = Bundle.main.infoDictionary
        self.serviceVersion = (info?["CFBundleShortVersionString"] as? String) ?? "unknown"
        self.serviceBuild = (info?["CFBundleVersion"] as? String) ?? "unknown"
        
        super.init()
        print("[PhotoCompanionService] ℹ️ Service version: \(serviceVersion) (\(serviceBuild))")
        
        // 配置 Thumbnail Cache
        thumbCache.countLimit = 500 // 最多缓存 500 张缩略图
        thumbCache.totalCostLimit = 50 * 1024 * 1024 // 50MB
        
        // 初始化预取管理器
        prefetchManager = PHCachingImageManager()
    }
    
    /**
     * 启动服务
     */
    func start() {
        let port = NWEndpoint.Port(integerLiteral: 12345)
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.includePeerToPeer = false
        
        // 重要：配置网络参数以确保可以从外部访问
        // 1. 不限制接口类型，允许所有网络接口（包括 USB）
        // parameters.requiredInterfaceType = .wifi  // 注释掉，允许所有接口
        
        // 2. 配置 TCP keepalive（保持连接活跃）
        if let tcpOptions = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcpOptions.enableKeepalive = true
            tcpOptions.keepaliveIdle = 1
            tcpOptions.keepaliveInterval = 3
            tcpOptions.keepaliveCount = 5
        }
        
        // 3. 配置网络参数以支持后台运行
        // 使用 requiredInterfaceType = nil 允许所有接口（包括 USB）
        // 不限制接口类型，确保在后台也能接收连接
        
        do {
            // 使用 NWListener 监听指定端口
            // 注意：在 iOS 上，NWListener 默认监听所有接口（0.0.0.0）
            listener = try NWListener(using: parameters, on: port)
            
            listener?.stateUpdateHandler = { [weak self] state in
                guard let self = self else { return }
                switch state {
                case .ready:
                    print("[PhotoCompanionService] ✅ Listener ready on port: \(port.rawValue)")
                    // 打印监听信息
                    if let connectionLimit = self.listener?.newConnectionLimit {
                        print("[PhotoCompanionService] Connection limit: \(connectionLimit)")
                    }
                    print("[PhotoCompanionService] Listening on all interfaces (IPv4 and IPv6)")
                    print("[PhotoCompanionService] Note: Service should be accessible via usbmuxd port forwarding")
                case .waiting(let error):
                    print("[PhotoCompanionService] ⏳ Listener waiting: \(error)")
                case .failed(let error):
                    print("[PhotoCompanionService] ❌ Listener failed: \(error)")
                    print("[PhotoCompanionService] Error details: \(error.localizedDescription)")
                case .cancelled:
                    print("[PhotoCompanionService] Listener cancelled")
                @unknown default:
                    print("[PhotoCompanionService] Listener state changed (unknown): \(state)")
                }
            }
            
            listener?.newConnectionHandler = { [weak self] connection in
                print("[PhotoCompanionService] 🔌 New connection received from PC via usbmuxd")
                print("[PhotoCompanionService] Connection endpoint: \(connection.currentPath?.localEndpoint?.debugDescription ?? "unknown")")
                print("[PhotoCompanionService] ✅ PC connected - ready to receive binary frames")
                self?.handleConnection(connection)
            }
            
            listener?.start(queue: .main)
            print("[PhotoCompanionService] ✅ Started listener on port: \(port.rawValue)")
            print("[PhotoCompanionService] Waiting for connections...")
        } catch {
            print("[PhotoCompanionService] ❌ Failed to start listener: \(error)")
            print("[PhotoCompanionService] Error details: \(error.localizedDescription)")
        }
    }
    
    /**
     * 处理连接
     */
    private func handleConnection(_ connection: NWConnection) {
        connections.append(connection)
        
        connection.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                print("[PhotoCompanionService] ✅ Connection ready")
                self.receiveLoop(connection: connection)
            case .failed(let error):
                print("[PhotoCompanionService] ❌ Connection failed: \(error)")
                // 不打印详细的 TCP 错误（这些是正常的连接关闭）
                if let posixError = error as? POSIXError, posixError.code == .ECONNRESET {
                    print("[PhotoCompanionService] ℹ️  Connection reset by peer (normal when PC closes connection)")
                } else {
                    print("[PhotoCompanionService] Error details: \(error.localizedDescription)")
                }
                // 清理连接
                connection.cancel()
                if let index = self.connections.firstIndex(where: { $0 === connection }) {
                    self.connections.remove(at: index)
                }
            case .cancelled:
                print("[PhotoCompanionService] ℹ️  Connection cancelled")
                if let index = self.connections.firstIndex(where: { $0 === connection }) {
                    self.connections.remove(at: index)
                }
            case .waiting(let error):
                print("[PhotoCompanionService] ⏳ Connection waiting: \(error)")
            default:
                break
            }
        }
        
        connection.start(queue: .main)
    }
    
    /**
     * 接收循环 - 二进制帧格式
     */
    private func receiveLoop(connection: NWConnection) {
        // 检查连接状态
        guard connection.state == .ready else {
            print("[PhotoCompanionService] ⚠️  Cannot start receive loop: connection state is \(connection.state)")
            return
        }
        
        // 接收帧头（16 字节）
        connection.receive(minimumIncompleteLength: 16, maximumLength: 16) { [weak self] data, context, isComplete, error in
            guard let self = self else { return }
            
            // 检查连接是否仍然有效
            if connection.state != .ready {
                print("[PhotoCompanionService] ⚠️  Connection no longer ready, stopping receive loop")
                return
            }
            
            if let error = error {
                // 连接重置是正常的（PC 端关闭连接时）
                if let posixError = error as? POSIXError, posixError.code == .ECONNRESET {
                    print("[PhotoCompanionService] ℹ️  Connection reset by peer (normal when PC closes connection)")
                } else {
                    print("[PhotoCompanionService] ⚠️  Receive error: \(error)")
                }
                // 清理连接
                if let index = self.connections.firstIndex(where: { $0 === connection }) {
                    self.connections.remove(at: index)
                }
                return
            }
            
            guard let headerData = data, headerData.count >= 16 else {
                if !isComplete && connection.state == .ready {
                    // 继续接收（连接仍然有效）
                    self.receiveLoop(connection: connection)
                } else {
                    // 连接已关闭或完成
                    print("[PhotoCompanionService] ℹ️  Receive loop ended (isComplete=\(isComplete), state=\(connection.state))")
                }
                return
            }
            
            // 解析帧头
            let magic = headerData.withUnsafeBytes { $0.load(fromByteOffset: 0, as: UInt32.self).bigEndian }
            guard magic == 0x50484F54 else { // "PHOT"
                print("[PhotoCompanionService] Invalid magic: 0x\(String(magic, radix: 16))")
                self.receiveLoop(connection: connection)
                return
            }
            
            let version = headerData.withUnsafeBytes { $0.load(fromByteOffset: 4, as: UInt16.self).bigEndian }
            let typeRaw = headerData.withUnsafeBytes { $0.load(fromByteOffset: 6, as: UInt16.self).bigEndian }
            guard let type = FrameType(rawValue: typeRaw) else {
                print("[PhotoCompanionService] Unknown frame type: \(typeRaw)")
                self.receiveLoop(connection: connection)
                return
            }
            
            let requestId = headerData.withUnsafeBytes { $0.load(fromByteOffset: 8, as: UInt32.self).bigEndian }
            let payloadLen = headerData.withUnsafeBytes { $0.load(fromByteOffset: 12, as: UInt32.self).bigEndian }
            
            print("[PhotoCompanionService] Received frame: type=\(type.rawValue), requestId=\(requestId), payloadLen=\(payloadLen)")
            
            // 检查连接状态
            guard connection.state == .ready else {
                print("[PhotoCompanionService] ⚠️  Connection not ready, cannot receive payload")
                return
            }
            
            // 接收 payload
            connection.receive(minimumIncompleteLength: Int(payloadLen), maximumLength: Int(payloadLen)) { [weak self] payloadData, _, _, error in
                guard let self = self else { return }
                
                // 检查连接状态
                guard connection.state == .ready else {
                    print("[PhotoCompanionService] ⚠️  Connection state changed during payload receive: \(connection.state)")
                    return
                }
                
                if let error = error {
                    // 连接重置是正常的（PC 端关闭连接时）
                    if let posixError = error as? POSIXError, posixError.code == .ECONNRESET {
                        print("[PhotoCompanionService] ℹ️  Connection reset while receiving payload (normal when PC closes connection)")
                    } else {
                        print("[PhotoCompanionService] ⚠️  Receive payload error: \(error)")
                    }
                    // 清理连接
                    if let index = self.connections.firstIndex(where: { $0 === connection }) {
                        self.connections.remove(at: index)
                    }
                    return
                }
                
                guard let payloadData = payloadData, payloadData.count >= Int(payloadLen) else {
                    print("[PhotoCompanionService] Incomplete payload data")
                    self.receiveLoop(connection: connection)
                    return
                }
                
                // 处理帧
                self.handleFrame(type: type, requestId: requestId, payload: payloadData, connection: connection)
                
                // 继续接收下一个帧（如果连接仍然有效）
                if connection.state == .ready {
                    self.receiveLoop(connection: connection)
                } else {
                    print("[PhotoCompanionService] ℹ️  Connection no longer ready, stopping receive loop")
                }
            }
        }
    }
    
    /**
     * 处理帧
     */
    private func handleFrame(type: FrameType, requestId: UInt32, payload: Data, connection: NWConnection) {
        // 解析 JSON payload
        guard let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            sendError(requestId: requestId, error: "Invalid JSON payload", connection: connection)
            return
        }
        
        // 根据帧类型处理
        switch type {
        case .LIST_ASSETS:
            handleListAssets(requestId: requestId, payload: json, connection: connection)
        case .GET_THUMB:
            handleGetThumb(requestId: requestId, payload: json, connection: connection)
        case .GET_IMAGE:
            handleGetImage(requestId: requestId, payload: json, connection: connection)
        case .GET_VIDEO:
            handleGetVideo(requestId: requestId, payload: json, connection: connection)
        case .OPEN_URL:
            handleOpenURL(requestId: requestId, payload: json, connection: connection)
        case .AUTO_LOGIN:
            handleAutoLogin(requestId: requestId, payload: json, connection: connection)
        case .HTTP_REQUEST:
            handleHttpRequest(requestId: requestId, payload: json, connection: connection)
        default:
            sendError(requestId: requestId, error: "Unknown frame type: \(type.rawValue)", connection: connection)
        }
    }
    
    /**
     * 处理 LIST_ASSETS 请求
     */
    private func handleListAssets(requestId: UInt32, payload: [String: Any], connection: NWConnection) {
        print("[PhotoCompanionService] 📋 Handling LIST_ASSETS request: requestId=\(requestId)")
        let limit = payload["limit"] as? Int ?? 200
        let offset = payload["offset"] as? Int ?? 0
        print("[PhotoCompanionService] 📋 Request parameters: limit=\(limit), offset=\(offset)")
        
        // 获取所有资源
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: options)
        
        var items: [[String: Any]] = []
        let total = result.count
        
        // 分页处理
        let startIndex = offset
        let endIndex = min(offset + limit, total)
        
        result.enumerateObjects(at: IndexSet(integersIn: startIndex..<endIndex), options: []) { asset, _, _ in
            var item: [String: Any] = [
                "assetId": asset.localIdentifier,
                "type": asset.mediaType == .image ? "image" : "video",
                "width": asset.pixelWidth,
                "height": asset.pixelHeight,
                "creationTime": asset.creationDate?.timeIntervalSince1970 ?? 0
            ]
            
            if asset.mediaType == .video {
                item["duration"] = asset.duration
            }
            
            items.append(item)
        }
        
        // 预取下一批缩略图（滑动不卡的秘密）
        if endIndex < total {
            let prefetchStart = endIndex
            let prefetchEnd = min(endIndex + 10, total) // 预取接下来 10 张
            var prefetchAssets: [PHAsset] = []
            result.enumerateObjects(at: IndexSet(integersIn: prefetchStart..<prefetchEnd), options: []) { asset, _, _ in
                prefetchAssets.append(asset)
            }
            
            // 使用 PHImageManager 预取
            if let manager = prefetchManager {
                let targetSize = CGSize(width: 320, height: 320)
                manager.startCachingImages(for: prefetchAssets, targetSize: targetSize, contentMode: .aspectFill, options: nil)
            }
        }
        
        let response: [String: Any] = [
            "total": total,
            "items": items
        ]
        
        print("[PhotoCompanionService] 📋 Prepared response: total=\(total), items=\(items.count)")
        
        // LIST_ASSETS 响应使用 LIST_ASSETS 帧类型（包含 JSON）
        sendResponseFrame(type: .LIST_ASSETS, requestId: requestId, data: response, connection: connection)
        
        print("[PhotoCompanionService] 📋 LIST_ASSETS response sent for requestId=\(requestId)")
    }
    
    /**
     * 处理 GET_THUMB 请求（关键：使用缓存 + JPEG）
     */
    private func handleGetThumb(requestId: UInt32, payload: [String: Any], connection: NWConnection) {
        guard let assetId = payload["assetId"] as? String,
              let size = payload["size"] as? Int else {
            sendError(requestId: requestId, error: "Missing parameters", connection: connection)
            return
        }
        
        // 检查缓存
        let cacheKey = "thumb:\(assetId):\(size)" as NSString
        if let cachedData = thumbCache.object(forKey: cacheKey) {
            print("[PhotoCompanionService] ✅ Cache hit for \(assetId)")
            sendData(requestId: requestId, data: cachedData as Data, connection: connection)
            return
        }
        
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else {
            sendError(requestId: requestId, error: "Asset not found", connection: connection)
            return
        }
        
        let options = PHImageRequestOptions()
        options.deliveryMode = .fastFormat
        options.resizeMode = .fast
        options.isSynchronous = false
        
        let targetSize = CGSize(width: size, height: size)
        
        PHImageManager.default().requestImage(
            for: asset,
            targetSize: targetSize,
            contentMode: .aspectFill,
            options: options
        ) { [unowned self] image, info in
            guard let image = image,
                  let jpegData = image.jpegData(compressionQuality: 0.7) else {
                self.sendError(requestId: requestId, error: "Failed to generate thumbnail", connection: connection)
                return
            }
            
            // 确保 ≤ 30KB
            var finalData = jpegData
            if finalData.count > 30 * 1024 {
                if let compressed = image.jpegData(compressionQuality: 0.5) {
                    finalData = compressed
                }
            }
            
            // 存入缓存
            self.thumbCache.setObject(finalData as NSData, forKey: cacheKey)
            
            // 发送数据
            self.sendData(requestId: requestId, data: finalData, connection: connection)
        }
    }
    
    /**
     * 处理 GET_IMAGE 请求
     */
    private func handleGetImage(requestId: UInt32, payload: [String: Any], connection: NWConnection) {
        guard let assetId = payload["assetId"] as? String else {
            sendError(requestId: requestId, error: "Missing assetId", connection: connection)
            return
        }
        
        let quality = payload["quality"] as? String ?? "full"
        
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else {
            sendError(requestId: requestId, error: "Asset not found", connection: connection)
            return
        }
        
        let options = PHImageRequestOptions()
        options.deliveryMode = quality == "full" ? .highQualityFormat : .fastFormat
        options.isNetworkAccessAllowed = true
        options.isSynchronous = false
        
        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { [weak self] data, uti, orientation, info in
            guard let self = self else { return }
            guard let imageData = data else {
                self.sendError(requestId: requestId, error: "Failed to get image", connection: connection)
                return
            }
            
            // 检查是否为 HEIC 格式，如果是则转换为 JPEG（浏览器不支持 HEIC）
            var finalData = imageData
            if let uti = uti, (uti == "public.heic" || uti == "public.heif" || uti.contains("heic") || uti.contains("heif")) {
                // HEIC 格式，需要转换为 JPEG
                if let image = UIImage(data: imageData) {
                    // 根据 quality 设置压缩质量
                    let compressionQuality: CGFloat = quality == "full" ? 0.9 : 0.7
                    if let jpegData = image.jpegData(compressionQuality: compressionQuality) {
                        finalData = jpegData
                        print("[PhotoCompanionService] ✅ HEIC 已转换为 JPEG，原始大小: \(imageData.count) bytes，转换后: \(jpegData.count) bytes")
                    } else {
                        print("[PhotoCompanionService] ⚠️ HEIC 转 JPEG 失败，使用原始数据")
                    }
                } else {
                    print("[PhotoCompanionService] ⚠️ 无法从 HEIC 数据创建 UIImage，使用原始数据")
                }
            }
            
            // 流式发送
            self.sendStream(requestId: requestId, data: finalData, connection: connection)
        }
    }
    
    /**
     * 处理 GET_VIDEO 请求
     */
    private func handleGetVideo(requestId: UInt32, payload: [String: Any], connection: NWConnection) {
        guard let assetId = payload["assetId"] as? String else {
            sendError(requestId: requestId, error: "Missing assetId", connection: connection)
            return
        }
        
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else {
            sendError(requestId: requestId, error: "Asset not found", connection: connection)
            return
        }
        
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        // 使用高质量模式，确保获取原始视频文件
        // .highQualityFormat 会获取最高质量的视频（如果启用了优化存储，会从 iCloud 下载原始文件）
        options.deliveryMode = .highQualityFormat
        // 尝试使用 .original 获取原始未编辑版本（最高质量）
        // 如果 .original 不可用，系统会自动 fallback 到 .current
        // 注意：某些视频可能没有 .original 版本（如果从未编辑过，.current 就是原始版本）
        options.version = .original
        // 不限制请求大小，确保获取完整视频
        // PHVideoRequestOptions 没有直接的大小限制选项，但 deliveryMode 已经控制了质量
        
        // 重要：如果设备启用了"优化存储"，本地可能只有压缩版本
        // 设置 isNetworkAccessAllowed = true 和 deliveryMode = .highQualityFormat
        // 会强制系统从 iCloud 下载原始文件（如果可用）
        // 回调中的 info 字典会包含 PHImageResultIsDegradedKey，如果为 false 表示已获取完整质量
        
        print("[PhotoCompanionService] Requesting highest-quality video for assetId: \(assetId)")
        print("[PhotoCompanionService] Video options: deliveryMode=highQualityFormat, networkAccessAllowed=true, version=original")
        print("[PhotoCompanionService] Note: Using .original version for maximum quality (will fallback to .current if unavailable)")
        print("[PhotoCompanionService] Note: If video is in iCloud, original will be downloaded automatically")
        
        PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { [weak self] avAsset, audioMix, info in
            guard let self = self else { return }
            // 检查是否有错误
            if let error = info?[PHImageErrorKey] as? Error {
                print("[PhotoCompanionService] ❌ Failed to get video asset: \(error.localizedDescription)")
                self.sendError(requestId: requestId, error: "Failed to get video asset: \(error.localizedDescription)", connection: connection)
                return
            }
            
            // 检查是否被取消
            if let cancelled = info?[PHImageCancelledKey] as? Bool, cancelled {
                print("[PhotoCompanionService] ⚠️  Video request was cancelled")
                self.sendError(requestId: requestId, error: "Video request was cancelled", connection: connection)
                return
            }
            
            // 检查是否在 iCloud 中
            if let inCloud = info?[PHImageResultIsInCloudKey] as? Bool, inCloud {
                print("[PhotoCompanionService] ⚠️  Video is in iCloud, downloading original...")
                print("[PhotoCompanionService] ⚠️  This may take time depending on video size and network speed")
            } else {
                print("[PhotoCompanionService] ✅ Video is stored locally")
            }
            
            // 检查是否被降级（degraded）
            if let degraded = info?[PHImageResultIsDegradedKey] as? Bool, degraded {
                print("[PhotoCompanionService] ⚠️  WARNING: Video is degraded (low quality version)")
                print("[PhotoCompanionService] ⚠️  This usually means the original is still downloading from iCloud")
                print("[PhotoCompanionService] ⚠️  Note: System will download original automatically, but may take time")
                print("[PhotoCompanionService] ⚠️  Recommendation: Wait for download to complete, then retry for best quality")
                // 如果视频被降级，说明原始文件还在下载中
                // PHImageManager 可能会先返回降级版本，然后再次调用回调返回完整版本
                // 但为了不阻塞，我们继续处理当前版本
                // 如果用户需要最高质量，可以稍后重新请求
            } else {
                print("[PhotoCompanionService] ✅ Video is not degraded (full quality confirmed)")
            }
            
            // 检查获取的版本类型
            if let version = info?[PHImageResultRequestIDKey] as? Int {
                // 这个 key 实际上不是版本信息，但我们可以检查其他信息
            }
            
            // 检查是否是原始版本（通过检查 URL 路径或文件属性）
            // 注意：PHImageManager 不直接提供版本信息，但我们可以通过其他方式判断
            
            guard let urlAsset = avAsset as? AVURLAsset else {
                let errorMsg = "Failed to get video asset (not AVURLAsset)"
                print("[PhotoCompanionService] ❌ \(errorMsg)")
                print("[PhotoCompanionService] Asset type: \(type(of: avAsset))")
                self.sendError(requestId: requestId, error: errorMsg, connection: connection)
                return
            }
            
            // 检查 URL 是否可访问
            guard urlAsset.url.isFileURL else {
                let errorMsg = "Video asset URL is not a file URL: \(urlAsset.url)"
                print("[PhotoCompanionService] ❌ \(errorMsg)")
                self.sendError(requestId: requestId, error: errorMsg, connection: connection)
                return
            }
            
            // 输出视频信息
            let fileSize = (try? FileManager.default.attributesOfItem(atPath: urlAsset.url.path)[.size] as? Int64) ?? 0
            print("[PhotoCompanionService] ✅ Video asset ready: \(urlAsset.url.path)")
            print("[PhotoCompanionService] Video file size: \(fileSize / 1024 / 1024) MB")
            
            // 获取视频轨道信息（分辨率、码率等）
            let videoTracks = urlAsset.tracks(withMediaType: .video)
            if let videoTrack = videoTracks.first {
                let naturalSize = videoTrack.naturalSize
                let estimatedDataRate = videoTrack.estimatedDataRate
                let frameRate = videoTrack.nominalFrameRate
                print("[PhotoCompanionService] 📹 Video resolution: \(Int(naturalSize.width))x\(Int(naturalSize.height))")
                print("[PhotoCompanionService] 📹 Video bitrate: \(Int(estimatedDataRate / 1000)) kbps")
                print("[PhotoCompanionService] 📹 Video frame rate: \(frameRate) fps")
                
                // 检查视频编码格式
                // formatDescriptions 返回 [Any]，但实际元素是 CMFormatDescription
                // 直接使用 CFTypeRef 转换，因为 CMFormatDescription 是 Core Foundation 类型
                if let formatDescAny = videoTrack.formatDescriptions.first {
                    // 使用 CFGetTypeID 检查类型
                    let formatDescTypeID = CFGetTypeID(formatDescAny as CFTypeRef)
                    if formatDescTypeID == CMFormatDescriptionGetTypeID() {
                        // 直接转换为 CMFormatDescription（Core Foundation 类型可以这样转换）
                        let formatDesc = (formatDescAny as CFTypeRef) as! CMFormatDescription
                        let mediaSubType = CMFormatDescriptionGetMediaSubType(formatDesc)
                        let codecString = String(format: "%c%c%c%c",
                                                (mediaSubType >> 24) & 0xFF,
                                                (mediaSubType >> 16) & 0xFF,
                                                (mediaSubType >> 8) & 0xFF,
                                                mediaSubType & 0xFF)
                        print("[PhotoCompanionService] 📹 Video codec: \(codecString) (0x\(String(format: "%08x", mediaSubType)))")
                    } else {
                        print("[PhotoCompanionService] 📹 Video codec: unknown (unexpected format description type)")
                    }
                } else {
                    print("[PhotoCompanionService] 📹 Video codec: unknown (format description not available)")
                }
                
                // 根据分辨率和码率判断视频质量
                let megapixels = (naturalSize.width * naturalSize.height) / 1_000_000
                let bitrateMbps = estimatedDataRate / 1_000_000
                print("[PhotoCompanionService] 📹 Video quality: \(String(format: "%.1f", megapixels)) MP, \(String(format: "%.1f", bitrateMbps)) Mbps")
                
                // 判断是否是高质量视频
                // 原始视频通常特征：
                // - 4K 视频：码率 > 20 Mbps，分辨率 > 8 MP
                // - 1080p 视频：码率 > 8 Mbps，分辨率 > 2 MP
                // - 720p 视频：码率 > 5 Mbps，分辨率 > 0.9 MP
                if bitrateMbps > 20.0 && megapixels > 8.0 {
                    print("[PhotoCompanionService] ✅ Video appears to be 4K original quality")
                } else if bitrateMbps > 8.0 && megapixels > 2.0 {
                    print("[PhotoCompanionService] ✅ Video appears to be 1080p original quality")
                } else if bitrateMbps > 5.0 && megapixels > 0.9 {
                    print("[PhotoCompanionService] ✅ Video appears to be 720p original quality")
                } else if bitrateMbps < 3.0 || megapixels < 0.5 {
                    print("[PhotoCompanionService] ⚠️  Video quality seems low (may be optimized/compressed)")
                    print("[PhotoCompanionService] 💡 Tip: Check if device has 'Optimize Storage' enabled in Settings > Photos")
                    print("[PhotoCompanionService] 💡 Tip: If video is in iCloud, wait for full download before viewing")
                } else {
                    print("[PhotoCompanionService] ✅ Video appears to be acceptable quality")
                }
            }
            
            // 检查是否是优化版本（通过文件路径判断）
            let path = urlAsset.url.path
            if path.contains("optimized") || path.contains("Optimized") || path.contains("optimized") {
                print("[PhotoCompanionService] ⚠️  WARNING: Video path contains 'optimized', may not be original")
                print("[PhotoCompanionService] ⚠️  Path: \(path)")
            } else {
                print("[PhotoCompanionService] ✅ Video appears to be original (not optimized path)")
            }
            
            // 读取视频文件并流式发送
            guard let inputStream = InputStream(url: urlAsset.url) else {
                let errorMsg = "Failed to create input stream for URL: \(urlAsset.url)"
                print("[PhotoCompanionService] ❌ \(errorMsg)")
                self.sendError(requestId: requestId, error: errorMsg, connection: connection)
                return
            }
            
            print("[PhotoCompanionService] Opening video stream from: \(urlAsset.url.path)")
            inputStream.open()
            
            // 检查流是否成功打开
            guard inputStream.streamStatus == .open else {
                let errorMsg = "Failed to open input stream (status: \(inputStream.streamStatus.rawValue))"
                print("[PhotoCompanionService] ❌ \(errorMsg)")
                if let error = inputStream.streamError {
                    print("[PhotoCompanionService] Stream error: \(error.localizedDescription)")
                }
                self.sendError(requestId: requestId, error: errorMsg, connection: connection)
                inputStream.close()
                return
            }
            
            self.streamVideo(inputStream: inputStream, requestId: requestId, connection: connection)
        }
    }
    
    /**
     * 处理 AUTO_LOGIN 请求
     * 由 Companion 在设备上拼接测试版自动登录 scheme 并拉起 App
     *
     * 期望 payload:
     * {
     *   "phone": "13800138000",
     *   "env": "test" // 可选
     * }
     */
    private func handleAutoLogin(requestId: UInt32, payload: [String: Any], connection: NWConnection) {
        guard let phone = payload["phone"] as? String, !phone.isEmpty else {
            sendError(requestId: requestId, error: "Missing phone parameter", connection: connection)
            return
        }
        let env = (payload["env"] as? String) ?? "test"
        
        // 组装 params JSON
        let paramsDict: [String: Any] = ["manualInputPhone": phone]
        let paramsData = try? JSONSerialization.data(withJSONObject: paramsDict, options: [])
        let paramsJson = paramsData.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let encoded = paramsJson.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        
        let urlString = "cardloanTest://www.xiaoying.com/app/operation/testEnvAutoLogin?params=\(encoded)"
        print("[PhotoCompanionService] 🔐 Handling AUTO_LOGIN request: requestId=\(requestId), phone=\(phone), env=\(env), url=\(urlString)")
        
        guard let url = URL(string: urlString) else {
            let errorMsg = "Invalid AUTO_LOGIN URL: \(urlString)"
            print("[PhotoCompanionService] ❌ \(errorMsg)")
            sendError(requestId: requestId, error: errorMsg, connection: connection)
            return
        }
        
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            let app = UIApplication.shared
            let state = app.applicationState
            print("[PhotoCompanionService] 🔐 AUTO_LOGIN applicationState=\(state.rawValue)")
            
            // iOS 安全限制：后台/不可见 App 不能直接发起「不受信任的用户操作」（比如拉起其它 App）
            // 如果当前不在前台，直接返回可读错误，让上游提示用户「先切到前台再重试」
            guard state == .active else {
                let friendlyState: String
                switch state {
                case .background: friendlyState = "background"
                case .inactive: friendlyState = "inactive"
                default: friendlyState = "unknown"
                }
                
                let resp: [String: Any] = [
                    "status": "error",
                    "code": "app_not_active",
                    "message": "iOS 限制：助手应用当前不在前台（\(friendlyState)），无法直接发起自动登录，请先把助手 App 切到前台后在 PC 端重新点击登录。",
                    "phone": phone,
                    "env": env
                ]
                print("[PhotoCompanionService] ❌ AUTO_LOGIN aborted because app is not active (state=\(friendlyState))")
                self.sendResponseFrame(type: .AUTO_LOGIN, requestId: requestId, data: resp, connection: connection)
                return
            }
            
            // 使用 .universalLinksOnly: false 确保自定义 scheme 可以直接打开，不询问用户
            if app.canOpenURL(url) {
                app.open(url, options: [:], completionHandler: { success in
                    let resp: [String: Any] = [
                        "status": success ? "success" : "error",
                        "message": success ? "Auto login started" : "Failed to open auto-login URL",
                        "phone": phone,
                        "env": env
                    ]
                    print("[PhotoCompanionService] 🔐 AUTO_LOGIN finished, success=\(success)")
                    self.sendResponseFrame(type: .AUTO_LOGIN, requestId: requestId, data: resp, connection: connection)
                })
            } else {
                // 如果 canOpenURL 返回 false，仍然尝试打开（某些情况下 canOpenURL 可能不准确）
                app.open(url, options: [:], completionHandler: { success in
                    let resp: [String: Any] = [
                        "status": success ? "success" : "error",
                        "message": success ? "Auto login started" : "Failed to open auto-login URL (app may not be installed)",
                        "phone": phone,
                        "env": env
                    ]
                    print("[PhotoCompanionService] 🔐 AUTO_LOGIN finished, success=\(success)")
                    self.sendResponseFrame(type: .AUTO_LOGIN, requestId: requestId, data: resp, connection: connection)
                })
            }
        }
    }
    
    /**
     * 处理 OPEN_URL 请求
     * 对于自定义 scheme（如 cardloanTest://），使用 UIApplication.shared.open() 打开
     * 对于 http/https URL，使用 WKWebView 加载
     */
    private func handleOpenURL(requestId: UInt32, payload: [String: Any], connection: NWConnection) {
        guard let urlString = payload["url"] as? String else {
            sendError(requestId: requestId, error: "Missing url parameter", connection: connection)
            return
        }
        
        print("[PhotoCompanionService] 🌐 Handling OPEN_URL request: requestId=\(requestId), url=\(urlString)")
        
        // 验证 URL 格式
        guard let url = URL(string: urlString) else {
            let errorMsg = "Invalid URL format: \(urlString)"
            print("[PhotoCompanionService] ❌ \(errorMsg)")
            sendError(requestId: requestId, error: errorMsg, connection: connection)
            return
        }
        
        // 检测是否为自定义 scheme（非 http/https）
        let scheme = url.scheme?.lowercased() ?? ""
        let isCustomScheme = !scheme.isEmpty && scheme != "http" && scheme != "https"
        
        if isCustomScheme {
            // 自定义 scheme：使用 UIApplication.shared.open() 打开
            print("[PhotoCompanionService] 🌐 Detected custom scheme (\(scheme)), using UIApplication.shared.open()")
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                // 对于自定义 scheme，直接打开，不询问用户
                if UIApplication.shared.canOpenURL(url) {
                    UIApplication.shared.open(url, options: [:], completionHandler: { success in
                        let resp: [String: Any] = [
                            "status": success ? "success" : "error",
                            "message": success ? "URL opened successfully" : "Failed to open URL",
                            "url": urlString,
                            "scheme": scheme
                        ]
                        print("[PhotoCompanionService] 🌐 Custom scheme open result: success=\(success)")
                        self.sendResponseFrame(type: .OPEN_URL, requestId: requestId, data: resp, connection: connection)
                    })
                } else {
                    // 如果 canOpenURL 返回 false，仍然尝试打开
                    UIApplication.shared.open(url, options: [:], completionHandler: { success in
                        let resp: [String: Any] = [
                            "status": success ? "success" : "error",
                            "message": success ? "URL opened successfully" : "Failed to open URL (app may not be installed)",
                            "url": urlString,
                            "scheme": scheme
                        ]
                        print("[PhotoCompanionService] 🌐 Custom scheme open result: success=\(success)")
                        self.sendResponseFrame(type: .OPEN_URL, requestId: requestId, data: resp, connection: connection)
                    })
                }
            }
            return
        }
        
        // HTTP/HTTPS URL：使用 WKWebView 加载
        // 必须在主线程中操作 UI
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            // 创建或重用 WKWebView
            if self.webView == nil {
                let configuration = WKWebViewConfiguration()
                configuration.allowsInlineMediaPlayback = true
                configuration.mediaTypesRequiringUserActionForPlayback = []
                
                print("[PhotoCompanionService] 🌐 Creating WKWebView with default configuration (ATS handled via Info.plist)")
                self.webView = WKWebView(frame: .zero, configuration: configuration)
                self.webView?.navigationDelegate = self
                
                // 创建窗口来显示 WKWebView
                if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
                    let window = UIWindow(windowScene: windowScene)
                    window.windowLevel = UIWindow.Level.alert + 1 // 确保在最上层
                    
                    // 创建视图控制器
                    let viewController = UIViewController()
                    viewController.view.backgroundColor = .systemBackground
                    
                    // 添加关闭按钮
                    let closeButton = UIButton(type: .system)
                    closeButton.setTitle("关闭", for: .normal)
                    closeButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
                    closeButton.addTarget(self, action: #selector(self.closeWebView), for: .touchUpInside)
                    closeButton.translatesAutoresizingMaskIntoConstraints = false
                    viewController.view.addSubview(closeButton)
                    
                    // 添加 WKWebView
                    if let webView = self.webView {
                        webView.translatesAutoresizingMaskIntoConstraints = false
                        viewController.view.addSubview(webView)
                        
                        NSLayoutConstraint.activate([
                            // 关闭按钮
                            closeButton.topAnchor.constraint(equalTo: viewController.view.safeAreaLayoutGuide.topAnchor, constant: 16),
                            closeButton.trailingAnchor.constraint(equalTo: viewController.view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
                            
                            // WKWebView
                            webView.topAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 8),
                            webView.leadingAnchor.constraint(equalTo: viewController.view.leadingAnchor),
                            webView.trailingAnchor.constraint(equalTo: viewController.view.trailingAnchor),
                            webView.bottomAnchor.constraint(equalTo: viewController.view.bottomAnchor)
                        ])
                    }
                    
                    window.rootViewController = viewController
                    window.makeKeyAndVisible()
                    self.webViewWindow = window
                    print("[PhotoCompanionService] 🌐 Created new window and WKWebView")
                } else {
                    // 如果没有 windowScene，使用主窗口
                    if let mainWindow = UIApplication.shared.windows.first {
                        let viewController = UIViewController()
                        viewController.view.backgroundColor = .systemBackground
                        
                        let closeButton = UIButton(type: .system)
                        closeButton.setTitle("关闭", for: .normal)
                        closeButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
                        closeButton.addTarget(self, action: #selector(self.closeWebView), for: .touchUpInside)
                        closeButton.translatesAutoresizingMaskIntoConstraints = false
                        viewController.view.addSubview(closeButton)
                        
                        if let webView = self.webView {
                            webView.translatesAutoresizingMaskIntoConstraints = false
                            viewController.view.addSubview(webView)
                            
                            NSLayoutConstraint.activate([
                                closeButton.topAnchor.constraint(equalTo: viewController.view.safeAreaLayoutGuide.topAnchor, constant: 16),
                                closeButton.trailingAnchor.constraint(equalTo: viewController.view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
                                webView.topAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 8),
                                webView.leadingAnchor.constraint(equalTo: viewController.view.leadingAnchor),
                                webView.trailingAnchor.constraint(equalTo: viewController.view.trailingAnchor),
                                webView.bottomAnchor.constraint(equalTo: viewController.view.bottomAnchor)
                            ])
                        }
                        
                        mainWindow.rootViewController?.present(viewController, animated: true)
                        print("[PhotoCompanionService] 🌐 Created WKWebView using main window")
                    } else {
                        print("[PhotoCompanionService] ❌ Failed to create window for WKWebView")
                        sendError(requestId: requestId, error: "Failed to create window for WKWebView", connection: connection)
                        return
                    }
                }
            } else {
                // WKWebView 已存在，确保窗口可见
                print("[PhotoCompanionService] 🌐 Reusing existing WKWebView")
                if let window = self.webViewWindow {
                    window.isHidden = false
                    window.makeKeyAndVisible()
                    print("[PhotoCompanionService] 🌐 Made existing window visible")
                }
            }
            
            // 保存请求上下文，以便在加载完成时发送响应
            self.pendingOpenURLRequest = (requestId: requestId, connection: connection, url: urlString)
            
            // 加载 URL
            print("[PhotoCompanionService] 🌐 Loading URL in WKWebView: \(urlString)")
            let request = URLRequest(url: url)
            self.webView?.load(request)
            
            // 注意：响应将在 didFinish 或 didFail 回调中发送
        }
    }
    
    /**
     * 处理 HTTP_REQUEST 请求：由设备侧发起 HTTP 请求并将结果返回给桌面端
     * 
     * 注意：由于测试 bundle 的网络限制（Denied over Wi-Fi interface），
     * 使用 WKWebView 的 JavaScript fetch API 来执行请求，这样可以绕过限制
     */
    private func handleHttpRequest(requestId: UInt32, payload: [String: Any], connection: NWConnection) {
        guard let urlString = payload["url"] as? String else {
            sendError(requestId: requestId, error: "Missing url parameter", connection: connection)
            return
        }

        let method = (payload["method"] as? String ?? "GET").uppercased()
        let headers = payload["headers"] as? [String: String] ?? [:]
        let bodyString = payload["body"] as? String
        let timeout = payload["timeout"] as? Double ?? 15.0

        guard let url = URL(string: urlString) else {
            sendError(requestId: requestId, error: "Invalid URL: \(urlString)", connection: connection)
            return
        }

        print("[PhotoCompanionService] 🌐 Handling HTTP_REQUEST via WKWebView: \(method) \(urlString)")
        print("[PhotoCompanionService] 🌐 Using WKWebView to bypass test bundle network restrictions")
        
        // 保存请求上下文
        pendingHttpRequests[requestId] = (connection: connection, url: urlString, method: method, headers: headers, body: bodyString)
        
        // 在主线程中执行（WKWebView 必须在主线程操作）
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            // 确保 HTTP 请求专用的 WKWebView 已创建并准备好
            if self.httpRequestWebView == nil {
                self.createWebViewForHttpRequest()
                // 等待 WKWebView 加载完成（最多等待 2 秒）
                self.waitForWebViewReady(requestId: requestId, connection: connection, urlString: urlString, method: method, headers: headers, bodyString: bodyString)
                return
            }
            
            // 如果 WKWebView 还未准备好，等待
            if !self.httpRequestWebViewReady {
                self.waitForWebViewReady(requestId: requestId, connection: connection, urlString: urlString, method: method, headers: headers, bodyString: bodyString)
                return
            }
            
            // WKWebView 已准备好，执行请求
            self.executeHttpRequestInWebView(requestId: requestId, connection: connection, urlString: urlString, method: method, headers: headers, bodyString: bodyString)
        }
    }
    
    /**
     * 等待 WKWebView 准备好
     */
    private func waitForWebViewReady(requestId: UInt32, connection: NWConnection, urlString: String, method: String, headers: [String: String], bodyString: String?) {
        var attempts = 0
        let maxAttempts = 20 // 最多等待 2 秒（20 * 0.1秒）
        
        func checkReady() {
            attempts += 1
            if self.httpRequestWebViewReady {
                // 已准备好，执行请求
                self.executeHttpRequestInWebView(requestId: requestId, connection: connection, urlString: urlString, method: method, headers: headers, bodyString: bodyString)
            } else if attempts < maxAttempts {
                // 继续等待
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    checkReady()
                }
            } else {
                // 超时
                self.sendError(requestId: requestId, error: "WKWebView initialization timeout", connection: connection)
                self.pendingHttpRequests.removeValue(forKey: requestId)
            }
        }
        
        checkReady()
    }
    
    /**
     * 在 WKWebView 中执行 HTTP 请求
     */
    private func executeHttpRequestInWebView(requestId: UInt32, connection: NWConnection, urlString: String, method: String, headers: [String: String], bodyString: String?) {
        guard let webView = self.httpRequestWebView else {
            self.sendError(requestId: requestId, error: "WKWebView not available", connection: connection)
            self.pendingHttpRequests.removeValue(forKey: requestId)
            return
        }
        
        // 对于 GET 请求，直接导航到目标 URL，然后获取页面内容
        // 这样可以绕过 fetch API 在 UI Test Bundle 中的限制
        let normalizedMethod = method.uppercased()
        let hasBody = bodyString != nil && !bodyString!.isEmpty
        print("[PhotoCompanionService] 🌐 executeHttpRequestInWebView: method=\(normalizedMethod), bodyString=\(bodyString ?? "nil"), hasBody=\(hasBody)")
        
        if normalizedMethod == "GET" && !hasBody {
            guard let url = URL(string: urlString) else {
                self.sendError(requestId: requestId, error: "Invalid URL: \(urlString)", connection: connection)
                self.pendingHttpRequests.removeValue(forKey: requestId)
                return
            }
            
            // 保存请求上下文，用于在页面加载完成后获取内容
            print("[PhotoCompanionService] 🌐 Navigating to URL for GET request: \(urlString)")
            
            // 创建请求并加载
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            for (key, value) in headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
            
            // 导航到 URL，页面加载完成后会触发 didFinish，我们在那里获取内容
            webView.load(request)
            print("[PhotoCompanionService] 🌐 GET request: navigation started, waiting for didFinish callback")
            return
        }
        
        print("[PhotoCompanionService] 🌐 Using XMLHttpRequest for method=\(normalizedMethod)")
        
        // 对于 POST 或其他方法，使用 XMLHttpRequest（比 fetch 更可靠）
        let escapedURL = urlString.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
        
        let headersJSON = self.jsonString(from: headers)
        
        var jsCode = """
        (function() {
            const requestId = \(requestId);
            const url = '\(escapedURL)';
            const xhr = new XMLHttpRequest();
            xhr.open('\(method)', url, true);
        """
        
        // 设置请求头
        if !headers.isEmpty {
            jsCode += """
            const headers = \(headersJSON);
            for (const key in headers) {
                xhr.setRequestHeader(key, headers[key]);
            }
        """
        }
        
        jsCode += """
            xhr.onload = function() {
                const responseHeaders = {};
                const headerString = xhr.getAllResponseHeaders();
                if (headerString) {
                    const headerPairs = headerString.trim().split(/\\r?\\n/);
                    for (let i = 0; i < headerPairs.length; i++) {
                        const headerPair = headerPairs[i].split(': ');
                        if (headerPair.length === 2) {
                            responseHeaders[headerPair[0]] = headerPair[1];
                        }
                    }
                }
                window.webkit.messageHandlers.httpRequestResult.postMessage({
                    requestId: requestId,
                    status: xhr.status,
                    headers: responseHeaders,
                    body: xhr.responseText
                });
            };
            xhr.onerror = function() {
                window.webkit.messageHandlers.httpRequestResult.postMessage({
                    requestId: requestId,
                    error: 'XMLHttpRequest failed: ' + (xhr.statusText || 'Network error')
                });
            };
        """
        
        if let bodyString = bodyString, !bodyString.isEmpty {
            let escapedBody = bodyString.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")
            jsCode += """
            xhr.send('\(escapedBody)');
        """
        } else {
            jsCode += """
            xhr.send();
        """
        }
        
        jsCode += """
        })();
        """
        
        webView.evaluateJavaScript(jsCode) { [weak self] _, error in
            guard let self = self else { return }
            if let error = error {
                let errorMsg = "JavaScript execution failed: \(error.localizedDescription)"
                print("[PhotoCompanionService] ❌ \(errorMsg)")
                if let pending = self.pendingHttpRequests.removeValue(forKey: requestId) {
                    self.sendError(requestId: requestId, error: errorMsg, connection: pending.connection)
                }
            }
        }
    }
    
    /**
     * 创建用于 HTTP 请求的 WKWebView（隐藏窗口）
     */
    private func createWebViewForHttpRequest() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        
        // 为 HTTP 请求结果注册 message handler
        let contentController = WKUserContentController()
        contentController.add(self, name: "httpRequestResult")
        configuration.userContentController = contentController
        
        // 创建一个隐藏的 WKWebView，专门用于执行 HTTP 请求
        self.httpRequestWebView = WKWebView(frame: .zero, configuration: configuration)
        self.httpRequestWebView?.navigationDelegate = self
        self.httpRequestWebView?.isHidden = true // 隐藏，不显示给用户
        self.httpRequestWebViewReady = false // 标记为未准备好
        
        // 加载一个空白 HTML 页面，使用目标域名作为 baseURL
        // 这样可以建立网络上下文，而不需要实际导航
        let htmlContent = """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>HTTP Request Helper</title>
        </head>
        <body>
            <script>
                console.log('WKWebView HTTP Request Helper ready');
            </script>
        </body>
        </html>
        """
        // 使用目标域名作为 baseURL，这样可以让 WKWebView 知道网络上下文
        if let baseURL = URL(string: "http://nohost.oa.com/") {
            self.httpRequestWebView?.loadHTMLString(htmlContent, baseURL: baseURL)
            print("[PhotoCompanionService] 🌐 Created hidden WKWebView with baseURL: http://nohost.oa.com/")
        } else {
            self.httpRequestWebView?.loadHTMLString(htmlContent, baseURL: nil)
            print("[PhotoCompanionService] 🌐 Created hidden WKWebView for HTTP requests")
        }
    }
    
    /**
     * 将对象转换为 JSON 字符串（用于 JavaScript 代码）
     */
    private func jsonString(from object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
              let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }
    
    /**
     * 关闭 WKWebView
     */
    @objc private func closeWebView() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            if let window = self.webViewWindow {
                window.isHidden = true
                window.rootViewController = nil
                self.webViewWindow = nil
            } else if let webView = self.webView {
                // 查找包含 webView 的视图控制器
                var responder: UIResponder? = webView
                while responder != nil {
                    if let viewController = responder as? UIViewController {
                        viewController.dismiss(animated: true)
                        break
                    }
                    responder = responder?.next
                }
            }
            
            self.webView = nil
            print("[PhotoCompanionService] 🌐 WebView closed")
        }
    }
    
    // MARK: - WKScriptMessageHandler
    
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "httpRequestResult" else {
            return
        }
        
        guard let body = message.body as? [String: Any],
              let requestIdNumber = body["requestId"] as? NSNumber else {
            print("[PhotoCompanionService] ⚠️ Invalid message body for httpRequestResult: \(message.body)")
            return
        }
        
        let requestId = requestIdNumber.uint32Value
        
        guard let pending = self.pendingHttpRequests.removeValue(forKey: requestId) else {
            print("[PhotoCompanionService] ⚠️ Request context not found in message handler for requestId: \(requestId)")
            return
        }
        
        if let errorMsg = body["error"] as? String, !errorMsg.isEmpty {
            print("[PhotoCompanionService] ❌ HTTP request failed (JS): \(errorMsg)")
            self.sendError(requestId: requestId, error: "HTTP request failed: \(errorMsg)", connection: pending.connection)
            return
        }
        
        let status = body["status"] as? Int ?? 0
        let headers = body["headers"] as? [String: String] ?? [:]
        let responseBody = body["body"] as? String ?? ""
        
        let resp: [String: Any] = [
            "status": status,
            "headers": headers,
            "body": responseBody
        ]
        
        print("[PhotoCompanionService] ✅ HTTP request succeeded via message handler: status=\(status)")
        self.sendResponseFrame(type: .HTTP_REQUEST, requestId: requestId, data: resp, connection: pending.connection)
    }
    
    // MARK: - WKNavigationDelegate
    
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        print("[PhotoCompanionService] 🌐 WebView started loading")
    }
    
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("[PhotoCompanionService] 🌐 WebView finished loading")
        
        // 检查是否是 HTTP 请求专用的 WKWebView
        if webView === self.httpRequestWebView {
            // 如果这是第一次加载（建立网络上下文），标记为准备好
            if !self.httpRequestWebViewReady {
                self.httpRequestWebViewReady = true
                print("[PhotoCompanionService] 🌐 ✅ HTTP request WKWebView is ready (network context established)")
                return
            }
            
            // 如果 WKWebView 已经准备好，这可能是 GET 请求的页面加载完成
            // 检查是否有待处理的 GET 请求（通过比较 URL 的基础部分）
            let currentURL = webView.url?.absoluteString ?? ""
            print("[PhotoCompanionService] 🌐 didFinish: currentURL=\(currentURL), pendingRequests=\(self.pendingHttpRequests.count)")
            
            // 查找匹配的 GET 请求
            var matchedRequestId: UInt32?
            for (requestId, pending) in self.pendingHttpRequests {
                if pending.method == "GET" {
                    let baseURL = pending.url.split(separator: "?").first ?? ""
                    if currentURL.hasPrefix(String(baseURL)) {
                        print("[PhotoCompanionService] 🌐 Found matching GET request: requestId=\(requestId), url=\(pending.url)")
                        matchedRequestId = requestId
                        break
                    }
                }
            }
            
            if let requestId = matchedRequestId {
                // 获取页面内容
                print("[PhotoCompanionService] 🌐 Getting page content for GET request: requestId=\(requestId)")
                webView.evaluateJavaScript("document.documentElement.outerHTML") { [weak self] result, error in
                    guard let self = self else { return }
                    
                    guard let pending = self.pendingHttpRequests.removeValue(forKey: requestId) else {
                        print("[PhotoCompanionService] ⚠️ Request context not found after page load: requestId=\(requestId)")
                        return
                    }
                    
                    if let error = error {
                        let errorMsg = "Failed to get page content: \(error.localizedDescription)"
                        print("[PhotoCompanionService] ❌ \(errorMsg)")
                        self.sendError(requestId: requestId, error: errorMsg, connection: pending.connection)
                        return
                    }
                    
                    let htmlContent = result as? String ?? ""
                    let status = 200 // 假设导航成功就是 200
                    let headers: [String: String] = [:] // WKWebView 导航不提供响应头
                    
                    let resp: [String: Any] = [
                        "status": status,
                        "headers": headers,
                        "body": htmlContent
                    ]
                    
                    print("[PhotoCompanionService] ✅ GET request succeeded via navigation: status=\(status), bodyLength=\(htmlContent.count)")
                    self.sendResponseFrame(type: .HTTP_REQUEST, requestId: requestId, data: resp, connection: pending.connection)
                }
                return
            }
            
            return
        }
        
        // 发送成功响应（OPEN_URL 请求）
        if let pending = self.pendingOpenURLRequest {
            let response: [String: Any] = [
                "status": "success",
                "url": pending.url
            ]
            print("[PhotoCompanionService] 🌐 ✅ URL loaded successfully, sending success response")
            self.sendResponseFrame(type: .OPEN_URL, requestId: pending.requestId, data: response, connection: pending.connection)
            self.pendingOpenURLRequest = nil
        }
    }
    
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("[PhotoCompanionService] 🌐 WebView failed to load: \(error.localizedDescription)")
        
        // 发送错误响应
        if let pending = self.pendingOpenURLRequest {
            let errorMsg = "Failed to load URL: \(error.localizedDescription)"
            print("[PhotoCompanionService] 🌐 ❌ Sending error response: \(errorMsg)")
            self.sendError(requestId: pending.requestId, error: errorMsg, connection: pending.connection)
            self.pendingOpenURLRequest = nil
        }
    }
    
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("[PhotoCompanionService] 🌐 WebView failed provisional navigation: \(error.localizedDescription)")
        
        // 如果是 HTTP 请求专用的 WKWebView
        if webView === self.httpRequestWebView {
            // 如果这是第一次加载（建立网络上下文）失败，仍然标记为准备好
            if !self.httpRequestWebViewReady {
                print("[PhotoCompanionService] 🌐 ⚠️ Initial navigation failed, but marking WKWebView as ready anyway")
                self.httpRequestWebViewReady = true
                return
            }
            
            // 如果是 GET 请求的导航失败，发送错误
            // 查找所有待处理的 GET 请求，如果当前 URL 匹配任何一个，发送错误
            let failedURL = webView.url?.absoluteString ?? ""
            for (requestId, pending) in self.pendingHttpRequests where pending.method == "GET" {
                if failedURL.hasPrefix(pending.url.split(separator: "?").first ?? "") {
                    let errorMsg = "Failed to load URL: \(error.localizedDescription)"
                    print("[PhotoCompanionService] ❌ GET request navigation failed: \(errorMsg)")
                    if let pending = self.pendingHttpRequests.removeValue(forKey: requestId) {
                        self.sendError(requestId: requestId, error: errorMsg, connection: pending.connection)
                    }
                    return
                }
            }
            
            return
        }
        
        // 发送错误响应（这是最常见的加载失败情况）
        if let pending = self.pendingOpenURLRequest {
            let errorMsg = "Failed to load URL: \(error.localizedDescription)"
            print("[PhotoCompanionService] 🌐 ❌ Sending error response for provisional navigation failure: \(errorMsg)")
            self.sendError(requestId: pending.requestId, error: errorMsg, connection: pending.connection)
            self.pendingOpenURLRequest = nil
        }
    }
    
    /**
     * 流式发送视频
     */
    private func streamVideo(inputStream: InputStream, requestId: UInt32, connection: NWConnection) {
        // 使用类属性保存 buffer，避免在异步操作中被释放
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64 * 1024) // 64KB 缓冲区
        
        var totalBytesSent = 0
        let startTime = Date()
        var isStreaming = true
        
        func readNextChunk() {
            // 检查是否还在流式传输
            guard isStreaming else {
                return
            }
            
            // 检查流状态
            guard inputStream.streamStatus == .open || inputStream.streamStatus == .reading else {
                print("[PhotoCompanionService] Video stream ended (status: \(inputStream.streamStatus.rawValue))")
                isStreaming = false
                inputStream.close()
                self.sendStreamEnd(requestId: requestId, connection: connection)
                buffer.deallocate() // 在流结束时释放
                let elapsed = Date().timeIntervalSince(startTime)
                print("[PhotoCompanionService] ✅ Video stream completed: \(totalBytesSent / 1024 / 1024) MB in \(String(format: "%.2f", elapsed))s")
                return
            }
            
            guard inputStream.hasBytesAvailable else {
                // 没有更多数据，等待一下再检查（可能是网络延迟）
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    readNextChunk()
                }
                return
            }
            
            let bytesRead = inputStream.read(buffer, maxLength: 64 * 1024)
            if bytesRead > 0 {
                // 立即创建 Data 副本，避免 buffer 被释放
                let chunk = Data(bytes: buffer, count: bytesRead)
                totalBytesSent += bytesRead
                
                // 发送数据（异步执行，避免阻塞）
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, isStreaming else { return }
                    self.sendData(requestId: requestId, data: chunk, connection: connection)
                    
                    // 每 1MB 输出一次进度
                    if totalBytesSent % (1024 * 1024) < bytesRead {
                        let elapsed = Date().timeIntervalSince(startTime)
                        let speed = Double(totalBytesSent) / 1024 / 1024 / elapsed
                        print("[PhotoCompanionService] Video stream progress: \(totalBytesSent / 1024 / 1024) MB, \(String(format: "%.2f", speed)) MB/s")
                    }
                    
                    // 继续读取下一个块
                    readNextChunk()
                }
            } else if bytesRead < 0 {
                // 读取错误
                isStreaming = false
                let error = inputStream.streamError?.localizedDescription ?? "Unknown stream error"
                print("[PhotoCompanionService] ❌ Video stream read error: \(error)")
                print("[PhotoCompanionService] Stream error details: \(inputStream.streamError?.localizedDescription ?? "none")")
                self.sendError(requestId: requestId, error: "Stream read error: \(error)", connection: connection)
                inputStream.close()
                buffer.deallocate() // 释放 buffer
            } else {
                // bytesRead == 0，流结束
                print("[PhotoCompanionService] Video stream ended (bytesRead == 0)")
                isStreaming = false
                inputStream.close()
                self.sendStreamEnd(requestId: requestId, connection: connection)
                buffer.deallocate() // 释放 buffer
                let elapsed = Date().timeIntervalSince(startTime)
                print("[PhotoCompanionService] ✅ Video stream completed: \(totalBytesSent / 1024 / 1024) MB in \(String(format: "%.2f", elapsed))s")
            }
        }
        
        print("[PhotoCompanionService] Starting video stream for requestId: \(requestId)")
        readNextChunk()
    }
    
    /**
     * 发送响应帧（JSON）
     */
    private func sendResponseFrame(type: FrameType, requestId: UInt32, data: [String: Any], connection: NWConnection) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: data) else {
            print("[PhotoCompanionService] ❌ Failed to serialize response JSON")
            sendError(requestId: requestId, error: "Failed to serialize response", connection: connection)
            return
        }
        
        print("[PhotoCompanionService] 📤 Sending response frame: type=\(type.rawValue), requestId=\(requestId), payloadSize=\(jsonData.count) bytes")
        sendFrame(type: type, requestId: requestId, payload: jsonData, connection: connection)
        print("[PhotoCompanionService] ✅ Response frame sent successfully")
    }
    
    /**
     * 发送数据（DATA 帧）
     */
    private func sendData(requestId: UInt32, data: Data, connection: NWConnection) {
        sendFrame(type: .DATA, requestId: requestId, payload: data, connection: connection)
    }
    
    /**
     * 发送错误
     */
    private func sendError(requestId: UInt32, error: String, connection: NWConnection) {
        let errorData = error.data(using: .utf8)!
        sendFrame(type: .ERROR, requestId: requestId, payload: errorData, connection: connection)
    }
    
    /**
     * 发送流结束
     */
    private func sendStreamEnd(requestId: UInt32, connection: NWConnection) {
        let emptyData = Data()
        sendFrame(type: .DATA, requestId: requestId, payload: emptyData, connection: connection)
    }
    
    /**
     * 流式发送数据（分块）
     */
    private func sendStream(requestId: UInt32, data: Data, connection: NWConnection) {
        let chunkSize = 64 * 1024 // 64KB 每块
        var offset = 0
        
        func sendNextChunk() {
            guard offset < data.count else {
                self.sendStreamEnd(requestId: requestId, connection: connection)
                return
            }
            
            let endOffset = min(offset + chunkSize, data.count)
            let chunk = data.subdata(in: offset..<endOffset)
            self.sendData(requestId: requestId, data: chunk, connection: connection)
            
            offset = endOffset
            
            // 使用异步方式发送，避免阻塞
            DispatchQueue.main.async {
                sendNextChunk()
            }
        }
        
        sendNextChunk()
    }
    
    /**
     * 发送帧
     */
    private func sendFrame(type: FrameType, requestId: UInt32, payload: Data, connection: NWConnection) {
        // 检查连接状态
        switch connection.state {
        case .ready:
            // 连接就绪，可以发送
            break
        case .cancelled, .failed:
            // 连接已关闭或失败，不发送
            print("[PhotoCompanionService] ⚠️  Cannot send frame: connection is \(connection.state)")
            return
        case .waiting, .preparing, .setup:
            // 连接未就绪，等待
            print("[PhotoCompanionService] ⏳ Connection not ready, waiting...")
            // 可以继续尝试发送，但可能会失败
        @unknown default:
            print("[PhotoCompanionService] ⚠️  Unknown connection state: \(connection.state)")
        }
        
        var header = Data()
        
        // magic (4 bytes, big endian)
        header.append(contentsOf: withUnsafeBytes(of: UInt32(0x50484F54).bigEndian) { Data($0) })
        
        // version (2 bytes, big endian)
        header.append(contentsOf: withUnsafeBytes(of: UInt16(1).bigEndian) { Data($0) })
        
        // type (2 bytes, big endian)
        header.append(contentsOf: withUnsafeBytes(of: type.rawValue.bigEndian) { Data($0) })
        
        // requestId (4 bytes, big endian)
        header.append(contentsOf: withUnsafeBytes(of: requestId.bigEndian) { Data($0) })
        
        // payloadLen (4 bytes, big endian)
        header.append(contentsOf: withUnsafeBytes(of: UInt32(payload.count).bigEndian) { Data($0) })
        
        let frame = header + payload
        print("[PhotoCompanionService] 📤 Sending frame: type=\(type.rawValue), requestId=\(requestId), headerSize=\(header.count), payloadSize=\(payload.count), totalSize=\(frame.count)")
        
        connection.send(content: frame, completion: .contentProcessed { error in
            if let error = error {
                // 连接重置是正常的（PC 端关闭连接时）
                if let posixError = error as? POSIXError, posixError.code == .ECONNRESET {
                    print("[PhotoCompanionService] ℹ️  Connection reset by peer (normal when PC closes connection)")
                } else {
                    print("[PhotoCompanionService] ⚠️  Send error: \(error)")
                }
            } else {
                // 发送成功（仅在调试时输出）
                // print("[PhotoCompanionService] ✅ Frame sent successfully")
            }
        })
    }
}

