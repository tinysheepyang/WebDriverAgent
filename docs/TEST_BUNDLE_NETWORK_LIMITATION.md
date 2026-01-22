# 测试 Bundle 网络限制问题

## 🔍 问题分析

**现象**：
- 设备 Safari 可以正常访问 `http://www.baidu.com`
- WebDriverAgent 返回错误 `-1009` (NSURLErrorNotConnectedToInternet)
- 已配置 ATS (`NSAllowsArbitraryLoads`, `NSAllowsArbitraryLoadsInWebContent`)
- 已参考 photo-proxy 的实现（使用 `defaultSessionConfiguration`）

**可能原因**：
iOS 测试 bundle (`.xctest`) 可能有特殊的网络限制，即使配置了 ATS 也可能无法访问网络。

## 📊 对比分析

### photo-proxy (正常工作)
- **类型**: 正常的 iOS App
- **网络访问**: ✅ 可以正常访问
- **配置**: `defaultSessionConfiguration` + ATS 配置

### WebDriverAgentRunner (失败)
- **类型**: 测试 bundle (`.xctest`)
- **网络访问**: ❌ 返回 -1009 错误
- **配置**: 相同的配置

## 🔧 已尝试的修复

1. ✅ 添加 ATS 配置 (`NSAllowsArbitraryLoads`, `NSAllowsArbitraryLoadsInWebContent`)
2. ✅ 使用 `defaultSessionConfiguration`（参考 photo-proxy）
3. ✅ 确保在主线程执行网络请求
4. ✅ 添加详细的错误诊断

## 💡 可能的解决方案

### 方案 1: 检查测试 bundle 的网络权限

测试 bundle 可能需要在 Xcode 项目设置中启用网络访问：

1. 打开 Xcode 项目
2. 选择 `WebDriverAgentRunner` target
3. 进入 **Signing & Capabilities**
4. 检查是否有网络相关的 Capability
5. 尝试添加 **Network Extensions** 或相关权限

### 方案 2: 使用 WKWebView 执行请求

由于 WKWebView 在 photo-proxy 中可以正常工作，可以考虑使用 WKWebView 来执行 HTTP 请求：

```objective-c
// 使用 WKWebView 加载 URL，然后通过 JavaScript 获取响应
// 这种方法可以绕过测试 bundle 的网络限制
```

### 方案 3: 检查系统限制

某些 iOS 版本或企业配置可能限制测试 bundle 的网络访问：

1. 检查 iOS 版本
2. 检查是否有 MDM 或企业策略限制
3. 检查设备的网络设置

### 方案 4: 使用代理或转发

如果测试 bundle 确实无法直接访问网络，可以考虑：

1. 通过 PC 端代理请求
2. 使用 WebDriverAgent 的 HTTP 服务器作为代理
3. 在 PC 端执行请求，然后返回结果

## 🔍 诊断步骤

### 1. 检查测试 bundle 类型

```bash
# 检查 bundle 类型
file WebDriverAgentRunner.app/WebDriverAgentRunner
# 应该显示: Mach-O universal binary with 2 architectures: [arm64:current ar archive] [armv7]
```

### 2. 检查网络权限

在 Xcode 中：
- 查看 `WebDriverAgentRunner` target 的 **Signing & Capabilities**
- 检查是否有网络相关的限制

### 3. 测试不同的 URL

```bash
# 测试 HTTPS
curl -X POST "http://localhost:8100/photos/http-request" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.baidu.com", "method": "GET"}' | python3 -m json.tool

# 测试本地网络
curl -X POST "http://localhost:8100/photos/http-request" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://127.0.0.1:8100/status", "method": "GET"}' | python3 -m json.tool
```

### 4. 检查系统日志

在 Xcode 控制台查看是否有网络相关的错误或警告。

## 📝 建议

如果测试 bundle 确实无法访问网络，建议：

1. **使用 PC 端代理**：在 PC 端执行 HTTP 请求，然后通过 WebDriverAgent 返回结果
2. **使用 WKWebView**：通过 WKWebView 加载 URL，然后提取响应
3. **检查系统限制**：确认是否有系统级别的限制

## 🎯 下一步

1. 检查 Xcode 项目设置中的网络权限
2. 尝试使用 HTTPS URL 测试
3. 考虑实现 PC 端代理方案
4. 如果确实无法解决，考虑使用 WKWebView 方案

## 📚 参考

- [iOS App Transport Security](https://developer.apple.com/documentation/security/preventing_insecure_network_connections)
- [URLSession Configuration](https://developer.apple.com/documentation/foundation/urlsessionconfiguration)
- [Testing Bundle Limitations](https://developer.apple.com/documentation/xctest)
