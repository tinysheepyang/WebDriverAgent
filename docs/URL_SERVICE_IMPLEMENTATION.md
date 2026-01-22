# URL Service 实现说明

## 概述

实现了通过 lockdown 启动 iOS Companion App，并使用 WKWebView 打开 URL 的功能，用于 nohost 环境切换。

## 已实现部分

### 1. 协议层（PC 端）

#### 消息类型定义 (`WebDriverAgent/photo-proxy/protocol/message.ts`)
- 添加了 `OPEN_URL = 5` 消息类型
- 添加了 `OpenURLRequest` 接口：`{ url: string }`

#### Bridge Service (`WebDriverAgent/photo-proxy/protocol/bridge.ts`)
- 添加了 `openURL(url: string)` 方法
- 通过 `sendRequest(MessageType.OPEN_URL, request)` 发送打开 URL 的请求

#### URL Service (`WebDriverAgent/photo-proxy/usb/url-service.ts`)
- 创建了 `URLService` 类
- 通过 `BridgeService` 连接到 iOS Companion App
- 实现了 `openURL(url)` 方法

#### IPC Handler (`WebDriverAgent/photo-proxy/ipc-handler.ts`)
- 添加了 URL Service 的 IPC handlers：
  - `url-service:set-device` - 设置设备
  - `url-service:connect` - 连接到 Companion App
  - `url-service:disconnect` - 断开连接
  - `url-service:open-url` - 打开 URL

#### Electron 主进程 (`electron/main.js`)
- 添加了 URL Service IPC handlers 的注册
- 实现了延迟加载机制

#### Preload (`electron/preload.cjs`)
- 暴露了 `window.electronAPI.urlService` API

#### iOS Manager (`src/utils/ios.js`)
- 修改了 `openURL` 方法：
  - 优先尝试通过 Companion App + WKWebView 打开
  - Fallback 到系统命令（如果 Companion App 不可用）

## iOS Companion App 需要实现的部分

### 1. 服务注册

在 iOS Companion App 中注册服务名称，确保 lockdownd 能够识别并启动：

```swift
// 在 Info.plist 或 ServiceRegistration.swift 中注册服务
// 服务名称：com.xiaoying.photo-companion
// 或者：com.xiaoying.photo-companion.service
```

### 2. 消息处理

在 iOS Companion App 中处理 `OPEN_URL` 消息类型（消息类型值：5）：

```swift
// 在消息处理逻辑中添加
case MessageType.OPEN_URL:
    handleOpenURL(message: message)
```

### 3. WKWebView 实现

实现打开 URL 的处理函数：

```swift
func handleOpenURL(message: Message) {
    guard let urlString = message.payload["url"] as? String,
          let url = URL(string: urlString) else {
        sendErrorResponse(messageId: message.messageId, error: "Invalid URL")
        return
    }
    
    // 在主线程中打开 WKWebView
    DispatchQueue.main.async {
        // 创建或获取 WKWebView 实例
        let webView = WKWebView(frame: view.bounds)
        let request = URLRequest(url: url)
        webView.load(request)
        
        // 将 WKWebView 添加到视图层级（或使用现有的视图控制器）
        // 例如：presentViewController 或 pushViewController
        
        // 发送成功响应
        sendSuccessResponse(messageId: message.messageId)
    }
}
```

### 4. 消息协议

确保消息格式匹配：

**请求消息格式：**
```json
{
  "messageId": 1,
  "url": "http://nohost.oa.com/cgi-bin/select?name=shiyangchen&envId=k8s002&time=1767599433492"
}
```

**响应消息格式：**
```json
{
  "messageId": 1,
  "success": true
}
```

或错误响应：
```json
{
  "messageId": 1,
  "error": "错误信息"
}
```

### 5. 消息序列化/反序列化

确保消息的序列化格式与 PC 端一致：
- 消息头：8 字节（4 字节消息类型 + 4 字节 JSON 长度）
- JSON payload：UTF-8 编码的 JSON 字符串
- 二进制数据（可选）：如果有的话

## 使用流程

1. **PC 端调用**：
   ```javascript
   await window.electronAPI.urlService.setDevice(device)
   await window.electronAPI.urlService.connect()
   await window.electronAPI.urlService.openURL(url)
   ```

2. **PC 端流程**：
   - 通过 usbmuxd 连接到设备
   - 通过 lockdownd 启动 iOS Companion Service
   - 发送 `OPEN_URL` 消息（消息类型 5）
   - 等待响应

3. **iOS 端流程**：
   - 接收 `OPEN_URL` 消息
   - 解析 URL
   - 在主线程中创建/显示 WKWebView
   - 加载 URL
   - 发送成功响应

## 注意事项

1. **服务名称**：确保 iOS Companion App 注册的服务名称与 `bridge.ts` 中尝试的服务名称之一匹配
2. **线程安全**：WKWebView 操作必须在主线程执行
3. **URL 验证**：iOS 端应该验证 URL 的有效性
4. **错误处理**：如果 URL 无效或加载失败，应该发送错误响应
5. **消息 ID**：确保响应消息的 `messageId` 与请求消息的 `messageId` 匹配

## 测试

1. 确保 iOS Companion App 已安装并注册服务
2. 连接 iOS 设备
3. 在公共功能区域选择 iOS 平台和设备
4. 选择 nohost 用户和环境
5. 点击"切换环境"按钮
6. 应该会在 iOS 设备的 WKWebView 中打开 nohost URL

