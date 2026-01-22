# PhotoCompanion 合并到 WebDriverAgentRunner 指南

## ✅ 已完成的工作

1. **代码文件已移动**
   - `AppDelegate.swift` → `WebDriverAgentRunner/AppDelegate.swift` (已重命名为 `PhotoCompanionServiceManager`)
   - `ServiceBinary.swift` → `WebDriverAgentRunner/ServiceBinary.swift`
   - 已删除 `PhotoCompanionApp.swift` 和 `ContentView.swift`（测试 bundle 不需要）

2. **Info.plist 已合并**
   - 已添加 `LSApplicationQueriesSchemes`（包含 `cardloanTest`）
   - 已添加 `NSAppTransportSecurity` 配置（包含 `oa.com` 域名）
   - 照片权限描述已存在

3. **代码已修改**
   - `AppDelegate.swift` 已改为 `PhotoCompanionServiceManager`，可在测试 bundle 中使用
   - `UITestingUITests.m` 已添加服务启动代码

## 📋 需要在 Xcode 中完成的步骤

### 1. 添加 Swift 文件到项目

1. 打开 `WebDriverAgent.xcodeproj`
2. 在项目导航器中，选择 `WebDriverAgentRunner` target
3. 右键点击 `WebDriverAgentRunner` 文件夹，选择 "Add Files to WebDriverAgentRunner..."
4. 选择以下文件：
   - `WebDriverAgentRunner/AppDelegate.swift`
   - `WebDriverAgentRunner/ServiceBinary.swift`
5. 确保勾选 "Copy items if needed"（如果文件不在项目目录中）
6. 确保 "Add to targets" 中勾选了 `WebDriverAgentRunner`

### 2. 配置 Swift 编译设置

1. 选择项目根节点
2. 选择 `WebDriverAgentRunner` target
3. 在 "Build Settings" 中搜索 "Swift"
4. 确保以下设置正确：
   - **Swift Language Version**: Swift 5
   - **Swift Compiler - General**: 
     - **Objective-C Bridging Header**: （留空，Xcode 会自动生成）
     - **Defines Module**: YES
   - **Swift Compiler - Code Generation**:
     - **Objective-C Generated Interface Header Name**: `WebDriverAgentRunner-Swift.h`

### 3. 在 Objective-C 中导入 Swift 头文件

在 `UITestingUITests.m` 文件顶部添加：

```objc
#import "WebDriverAgentRunner-Swift.h"
```

或者使用：

```objc
@import WebDriverAgentRunner;
```

### 4. 验证编译

1. 选择 `WebDriverAgentRunner` scheme
2. 选择目标设备（真机或模拟器）
3. 按 `Cmd+B` 编译项目
4. 如果出现 Swift 相关错误，检查：
   - Swift 文件是否已添加到 target
   - Swift 版本是否正确
   - 是否有循环依赖

### 5. 删除独立的 PhotoCompanion 项目（可选）

如果不再需要独立的 PhotoCompanion 项目，可以删除：

```bash
rm -rf WebDriverAgent/photo-proxy/PhotoCompanion.xcodeproj
```

注意：保留 `photo-proxy/PhotoCompanion/` 目录中的其他文件（如 Assets、Info.plist 等），因为它们可能在其他地方被引用。

## 🔍 验证合并是否成功

1. **编译成功**：项目应该能够成功编译
2. **服务启动**：运行 WebDriverAgentRunner 后，应该能看到 Photo Companion Service 的启动日志
3. **功能测试**：通过 PC 端连接，测试照片访问功能是否正常

## 📝 注意事项

1. **Swift 和 Objective-C 混编**：
   - Xcode 会自动生成 `-Swift.h` 头文件
   - 确保 Swift 类使用 `@objc` 标记才能在 Objective-C 中使用
   - `PhotoCompanionServiceManager` 已经标记为 `@objc`

2. **后台运行**：
   - WebDriverAgentRunner 是测试 bundle，不是独立的 App
   - 后台模式配置在 Info.plist 中已设置
   - 服务会在测试启动时自动启动

3. **权限**：
   - 照片访问权限会在服务启动时请求
   - 确保 Info.plist 中包含正确的权限描述

## 🐛 常见问题

### 问题 1: 找不到 Swift 类

**解决方案**：
- 检查 Swift 文件是否已添加到 target
- 检查 `SWIFT_OBJC_INTERFACE_HEADER_NAME` 设置
- 确保在 Objective-C 文件中正确导入 Swift 头文件

### 问题 2: 编译错误：找不到模块

**解决方案**：
- 清理构建文件夹（Product → Clean Build Folder）
- 删除 DerivedData
- 重新编译

### 问题 3: 服务未启动

**解决方案**：
- 检查 `testRunner` 方法中是否正确调用了 `startService`
- 检查日志输出，查看是否有错误信息
- 确保照片权限已授予

## 📚 参考

- [Apple: Mixing Swift and Objective-C](https://developer.apple.com/documentation/swift/imported-c-and-objective-c-apis/importing-swift-into-objective-c)
- [Xcode: Adding Swift Files to Objective-C Projects](https://developer.apple.com/documentation/swift/imported-c-and-objective-c-apis/importing-swift-into-objective-c)
