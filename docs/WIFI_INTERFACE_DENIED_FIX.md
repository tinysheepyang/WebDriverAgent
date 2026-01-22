# Wi-Fi 接口被拒绝问题修复

## 🔍 错误分析

从 Xcode 控制台日志中发现关键错误：

```
_NSURLErrorNWPathKey=unsatisfied (Denied over Wi-Fi interface)
interface: en0[802.11], ipv4, dns, proxy, uses wifi
```

**问题**：系统拒绝了测试 bundle 对 Wi-Fi 接口的访问。

## ✅ 修复方案

### 1. 添加 UIBackgroundModes

参考 photo-proxy 的实现，添加 `UIBackgroundModes` 配置：

```xml
<key>UIBackgroundModes</key>
<array>
    <string>processing</string>
    <string>voip</string>
</array>
```

**说明**：
- `processing`：允许后台处理任务
- `voip`：允许 VoIP 网络访问（可能有助于网络权限）

### 2. 检查 Xcode 项目设置

在 Xcode 中检查 `WebDriverAgentRunner` target：

1. **Signing & Capabilities**
   - 检查是否有网络相关的 Capability
   - 确认 App Sandbox 设置（如果有）

2. **Build Settings**
   - 检查 `ENABLE_HARDENED_RUNTIME`
   - 检查代码签名设置

3. **Info.plist**
   - 确认已添加 `NSLocalNetworkUsageDescription`
   - 确认已添加 `UIBackgroundModes`

## 🔧 已应用的修复

1. ✅ 添加 `UIBackgroundModes` 配置
2. ✅ 已配置 `NSLocalNetworkUsageDescription`
3. ✅ 已配置 ATS (`NSAllowsArbitraryLoads`, `NSAllowsArbitraryLoadsInWebContent`)

## 📝 测试步骤

1. **重新编译 WebDriverAgent**
   ```bash
   # 在 Xcode 中重新编译并运行 WebDriverAgentRunner
   ```

2. **测试网络诊断**
   ```bash
   curl "http://localhost:8100/photos/network-diagnosis" | python3 -m json.tool
   ```

3. **查看 Xcode 控制台**
   - 检查是否还有 `Denied over Wi-Fi interface` 错误
   - 查看网络请求是否成功

## ⚠️ 如果仍然失败

如果添加 `UIBackgroundModes` 后仍然失败，可能需要：

### 方案 1: 检查 Xcode 项目设置

1. 打开 Xcode
2. 选择 `WebDriverAgentRunner` target
3. 进入 **Signing & Capabilities**
4. 检查是否有网络限制
5. 尝试添加 **Network Extensions** capability（如果可用）

### 方案 2: 检查设备设置

1. 在设备上：**设置 > 通用 > VPN 与设备管理**
2. 检查是否有配置文件限制网络访问
3. 检查是否有 MDM 策略限制

### 方案 3: 使用替代方案

如果测试 bundle 确实无法获得网络权限，考虑：

1. **PC 端代理**：在 PC 端执行 HTTP 请求
2. **WKWebView**：使用 WKWebView 加载 URL（可能绕过限制）

## 📊 错误信息解读

```
Connection 2: received failure notification
Connection 2: failed to connect 1:50, reason -1
Connection 2: encountered error(1:50)
Task <...> HTTP load failed, 0/0 bytes (error code: -1009 [1:50])
```

- `1:50`：POSIX 错误代码（50 = ENETDOWN，网络接口关闭）
- `-1009`：NSURLErrorNotConnectedToInternet
- `Denied over Wi-Fi interface`：Wi-Fi 接口被拒绝

## 🎯 预期结果

修复后应该：
- ✅ 不再出现 `Denied over Wi-Fi interface` 错误
- ✅ 网络请求能够成功执行
- ✅ 可以访问 `http://www.baidu.com` 和内网域名

## 📚 参考

- [UIBackgroundModes](https://developer.apple.com/documentation/bundleresources/information_property_list/uibackgroundmodes)
- [Network Path Errors](https://developer.apple.com/documentation/foundation/url_loading_system/handling_an_authentication_challenge)
- [iOS Network Permissions](https://developer.apple.com/documentation/network/network_permissions)
