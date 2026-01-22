/**
 * iOS Companion Service - App Delegate
 *
 * 应用入口，启动 PhotoCompanionService
 */

import UIKit
import Photos
import AVFoundation

class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var photoService: PhotoCompanionServiceBinary?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var audioSession: AVAudioSession?
    
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 配置音频会话以保持应用在后台运行
        setupAudioSession()
        
        // 请求照片访问权限
        PHPhotoLibrary.requestAuthorization { status in
            if status == .authorized || status == .limited {
                print("[AppDelegate] Photo library access granted")
                // 启动服务
                DispatchQueue.main.async {
                    self.photoService = PhotoCompanionServiceBinary()
                    self.photoService?.start()
                    print("[AppDelegate] ✅ Photo Companion Service started")
                    print("[AppDelegate] ✅ Service can run in background (no Xcode connection required)")
                }
            } else {
                print("[AppDelegate] ❌ Photo library access denied")
                print("[AppDelegate] Please grant photo library access in Settings")
            }
        }
        
        // 创建窗口（即使不需要 UI，也需要一个窗口）
        window = UIWindow(frame: UIScreen.main.bounds)
        let viewController = UIViewController()
        viewController.view.backgroundColor = .systemBackground
        
        // 添加状态标签
        let label = UILabel()
        label.text = "Photo Companion Service\n正在运行..."
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        viewController.view.addSubview(label)
        
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: viewController.view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: viewController.view.centerYAnchor)
        ])
        
        window?.rootViewController = viewController
        window?.makeKeyAndVisible()
        
        return true
    }
    
    func applicationDidEnterBackground(_ application: UIApplication) {
        print("[AppDelegate] App entered background")
        print("[AppDelegate] Starting background task to keep service running...")
        
        // 开始后台任务以保持服务运行
        beginBackgroundTask()
        
        // 确保音频会话激活（用于保持后台运行）
        activateAudioSession()
    }
    
    func applicationWillEnterForeground(_ application: UIApplication) {
        print("[AppDelegate] ✅ App entered foreground")
        print("[AppDelegate] Network connections are active")
        
        // 结束后台任务（应用已回到前台）
        endBackgroundTask()
    }
    
    func applicationWillTerminate(_ application: UIApplication) {
        print("[AppDelegate] Application terminating")
        endBackgroundTask()
    }
    
    // MARK: - Background Task Management
    
    private func beginBackgroundTask() {
        endBackgroundTask() // 先结束之前的任务
        
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "PhotoCompanionService") { [weak self] in
            print("[AppDelegate] Background task expired, requesting more time...")
            self?.endBackgroundTask()
            self?.beginBackgroundTask() // 重新申请后台任务
        }
        
        if backgroundTask != .invalid {
            print("[AppDelegate] ✅ Background task started: \(backgroundTask.rawValue)")
        }
    }
    
    private func endBackgroundTask() {
        if backgroundTask != .invalid {
            print("[AppDelegate] Ending background task: \(backgroundTask.rawValue)")
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
            print("[AppDelegate] ✅ Audio session configured for background operation")
        } catch {
            print("[AppDelegate] ⚠️  Failed to setup audio session: \(error)")
        }
    }
    
    private func activateAudioSession() {
        do {
            try audioSession?.setActive(true)
            print("[AppDelegate] ✅ Audio session activated (keeps app alive in background)")
        } catch {
            print("[AppDelegate] ⚠️  Failed to activate audio session: \(error)")
        }
    }
}

