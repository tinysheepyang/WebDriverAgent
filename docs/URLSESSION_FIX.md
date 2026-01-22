# URLSession 配置修复说明

## 🔍 问题分析

**现象**：设备 Safari 可以正常访问 `http://www.baidu.com`，但 WebDriverAgent 返回错误 `-1009` (NSURLErrorNotConnectedToInternet)

**可能原因**：
1. 测试 bundle 的网络权限限制
2. `defaultSessionConfiguration` 可能对测试 bundle 有限制
3. URLSession 配置不当导致网络请求失败

## ✅ 解决方案

已将 URLSession 配置从 `defaultSessionConfiguration` 改为 `ephemeralSessionConfiguration`，并添加了以下配置：

### 1. 使用 Ephemeral Session Configuration

```objective-c
NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
```

**优势**：
- 不存储 cookies、缓存或凭据到磁盘
- 更适合测试环境
- 避免测试 bundle 的网络限制

### 2. 添加网络配置

```objective-c
config.allowsCellularAccess = YES;  // 允许使用蜂窝数据
config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;  // 忽略缓存
if (@available(iOS 11.0, *)) {
  config.waitsForConnectivity = NO;  // 不等待网络连接
}
```

### 3. 设置 User-Agent

```objective-c
config.HTTPAdditionalHeaders = @{
  @"User-Agent": @"WebDriverAgent/1.0"
};
```

## 🔧 修改的文件

- `WebDriverAgentLib/Commands/FBPhotosCommands.m`
  - `handleHttpRequest:` 方法
  - `handleNetworkDiagnosis:` 方法

## 📝 测试步骤

1. **重新编译 WebDriverAgent**
   ```bash
   # 在 Xcode 中重新编译并运行 WebDriverAgentRunner
   ```

2. **测试网络诊断**
   ```bash
   curl "http://localhost:8100/photos/network-diagnosis" | python3 -m json.tool
   ```

3. **测试 HTTP 请求**
   ```bash
   curl -X POST "http://localhost:8100/photos/http-request" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "http://www.baidu.com",
       "method": "GET"
     }' | python3 -m json.tool
   ```

## ⚠️ 注意事项

### Ephemeral Session 的特点

- ✅ **优点**：
  - 不存储数据到磁盘，更安全
  - 适合测试环境
  - 避免缓存问题

- ⚠️ **限制**：
  - 每次创建新的 session，不共享 cookies
  - 不持久化缓存

### 如果仍然失败

如果使用 `ephemeralSessionConfiguration` 后仍然失败，可能的原因：

1. **测试 bundle 网络权限**
   - iOS 测试 bundle 可能确实有网络限制
   - 某些企业网络可能阻止测试 bundle 访问

2. **网络环境**
   - 设备网络环境与 Safari 不同
   - 可能需要检查网络代理设置

3. **系统限制**
   - iOS 系统可能对测试 bundle 有特殊限制
   - 可能需要使用其他方法

## 🔍 进一步排查

如果问题仍然存在，可以尝试：

1. **检查设备网络设置**
   - 确认设备网络连接正常
   - 检查是否有代理或 VPN

2. **测试其他 URL**
   - 尝试访问其他网站
   - 确认是否是特定域名的问题

3. **检查日志**
   - 查看 Xcode 控制台日志
   - 查看 WebDriverAgent 日志输出

4. **使用系统 API**
   - 如果 URLSession 确实无法工作，可能需要使用其他方法
   - 例如：使用 CFNetwork 或其他底层 API

## 📊 预期结果

修复后应该能够：
- ✅ 成功访问 `http://www.baidu.com`
- ✅ 成功访问内网域名（如 `nohost.oa.com`）
- ✅ 网络诊断返回成功状态

## 🎯 下一步

1. 重新编译 WebDriverAgent
2. 运行测试脚本
3. 查看结果

如果仍然失败，可能需要：
- 检查 iOS 系统版本
- 检查测试 bundle 的网络权限
- 考虑使用其他网络请求方法
