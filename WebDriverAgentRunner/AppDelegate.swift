/**
 * Photo Companion Service Manager
 *
 * 在 WebDriverAgentRunner 中启动 PhotoCompanionService
 */

import UIKit
import Photos
import AVFoundation

@objc class PhotoCompanionServiceManager: NSObject {
    @objc static let shared = PhotoCompanionServiceManager()
    
    private var photoService: PhotoCompanionServiceBinary?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var audioSession: AVAudioSession?
    private var isStarted = false
    
    private override init() {
        super.init()
    }
    
    @objc func startService() {
        guard !isStarted else {
            print("[PhotoCompanionServiceManager] Service already started")
            return
        }
        
        isStarted = true
        
        print("[PhotoCompanionServiceManager] Starting service...")
        
        // 确保在主线程上执行（XCTest 环境要求）
        if Thread.isMainThread {
            startServiceInternal()
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.startServiceInternal()
            }
        }
    }
    
    private func startServiceInternal() {
        // 配置音频会话以保持应用在后台运行
        setupAudioSession()
        
        // 检查当前授权状态（避免不必要的授权请求）
        let currentStatus = PHPhotoLibrary.authorizationStatus()
        let isAuthorized: Bool
        if #available(iOS 14, *) {
            isAuthorized = currentStatus == .authorized || currentStatus == .limited
        } else {
            isAuthorized = currentStatus == .authorized
        }
        
        if isAuthorized {
            // 已经授权，直接启动服务
            print("[PhotoCompanionServiceManager] Photo library access already granted")
            startServiceOnMainThread()
        } else {
            // 请求照片访问权限
            print("[PhotoCompanionServiceManager] Requesting photo library access...")
            PHPhotoLibrary.requestAuthorization { [weak self] status in
                guard let self = self else { return }
                
                // 检查授权状态（兼容 iOS 14+ 的 .limited 状态）
                let isAuthorized: Bool
                if #available(iOS 14, *) {
                    isAuthorized = status == .authorized || status == .limited
                } else {
                    isAuthorized = status == .authorized
                }
                
                if isAuthorized {
                    print("[PhotoCompanionServiceManager] Photo library access granted")
                    // 启动服务（确保在主线程）
                    DispatchQueue.main.async {
                        self.startServiceOnMainThread()
                    }
                } else {
                    print("[PhotoCompanionServiceManager] ❌ Photo library access denied")
                    print("[PhotoCompanionServiceManager] Please grant photo library access in Settings")
                    // 即使没有授权也尝试启动服务（某些功能可能不需要照片权限）
                    DispatchQueue.main.async {
                        self.startServiceOnMainThread()
                    }
                }
            }
        }
    }
    
    private func startServiceOnMainThread() {
        // 确保在主线程
        assert(Thread.isMainThread, "startServiceOnMainThread must be called on main thread")
        
        self.photoService = PhotoCompanionServiceBinary()
        self.photoService?.start()
        print("[PhotoCompanionServiceManager] ✅ Photo Companion Service started")
        print("[PhotoCompanionServiceManager] ✅ Service can run in background")
    }
    
    @objc func stopService() {
        guard isStarted else { return }
        
        isStarted = false
        photoService = nil
        endBackgroundTask()
        print("[PhotoCompanionServiceManager] Service stopped")
    }
    
    // MARK: - Background Task Management
    
    private func beginBackgroundTask() {
        endBackgroundTask() // 先结束之前的任务
        
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "PhotoCompanionService") { [weak self] in
            print("[PhotoCompanionServiceManager] Background task expired, requesting more time...")
            self?.endBackgroundTask()
            self?.beginBackgroundTask() // 重新申请后台任务
        }
        
        if backgroundTask != .invalid {
            print("[PhotoCompanionServiceManager] ✅ Background task started: \(backgroundTask.rawValue)")
        }
    }
    
    private func endBackgroundTask() {
        if backgroundTask != .invalid {
            print("[PhotoCompanionServiceManager] Ending background task: \(backgroundTask.rawValue)")
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }
    
    // MARK: - Audio Session (for keeping app alive in background)
    
    private func setupAudioSession() {
        do {
            audioSession = AVAudioSession.sharedInstance()
            try audioSession?.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try audioSession?.setActive(false) // 先不激活，等需要时再激活
            print("[PhotoCompanionServiceManager] ✅ Audio session configured for background operation")
        } catch {
            print("[PhotoCompanionServiceManager] ⚠️  Failed to setup audio session: \(error)")
        }
    }
    
    private func activateAudioSession() {
        do {
            try audioSession?.setActive(true)
            print("[PhotoCompanionServiceManager] ✅ Audio session activated (keeps app alive in background)")
        } catch {
            print("[PhotoCompanionServiceManager] ⚠️  Failed to activate audio session: \(error)")
        }
    }
}

