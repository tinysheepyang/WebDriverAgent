# iOS 26 go-ios v1.0.199 适配检查报告

## 一、go-ios 版本信息

- **版本**: v1.0.199
- **文件**: `commands/ios`
- **架构**: Universal binary (x86_64 + arm64)

## 二、runwda 命令参数检查

### 2.1 go-ios v1.0.199 官方参数格式

根据 `./commands/ios runwda --help` 输出：

```
ios runwda [--bundleid=<bundleid>] [--testrunnerbundleid=<testbundleid>] [--xctestconfig=<xctestconfig>] [--log-output=<file>] [--arg=<a>]... [--env=<e>]... [options]
```

**关键参数：**
- `--bundleid=<bundleid>` - WDA 测试运行器的 Bundle ID（通常是 `.xctrunner` 结尾）
- `--testrunnerbundleid=<testbundleid>` - 测试运行器的主 Bundle ID（去掉 `.xctrunner` 后缀）
- `--xctestconfig=<xctestconfig>` - XCTest 配置文件名称（如 `WebDriverAgentRunner.xctest`）

### 2.2 代码中的使用方式

**位置**: `src/utils/ios.js` 第 3783-3796 行

```javascript
if (wdaBundleId && testRunnerBundleId) {
  // 指定所有三个参数
  bundleIdPart = ` --bundleid=${wdaBundleId}`
  testRunnerBundleIdPart = ` --testrunnerbundleid=${testRunnerBundleId}`
  xctestConfigPart = ` --xctestconfig=${xctestConfig}`
  // ...
} else {
  // 不指定任何参数，让 runwda 使用默认值
  console.log('[ensureWdaRunningViaLaunch] iOS 26 不指定 bundle ID 参数，使用 runwda 默认值')
}
```

**✅ 适配状态：完全匹配**

- 参数名称正确：`--bundleid`、`--testrunnerbundleid`、`--xctestconfig`
- 参数格式正确：使用 `=` 连接参数名和值
- 参数完整性：遵循 "要么全部指定，要么全部不指定" 的规则

## 三、隧道参数检查

### 3.1 go-ios v1.0.199 隧道相关参数

根据帮助信息：

```
--address=<ipv6addrr>     Address of the device on the interface.
--rsd-port=<port>         Port of remote service discovery on the device through the tunnel
--userspace-port=<port>   Optional. Set this if you run a command supplying rsd-port and address and your device is using userspace tunnel
```

### 3.2 代码中的使用方式

**位置**: `src/utils/ios.js` 第 3798-3805 行

```javascript
if (needsTunnel) {
  const tunnelInfo = await this.getTunnelInfo()
  if (tunnelInfo.success && tunnelInfo.address && tunnelInfo.rsdPort) {
    const userspacePart = (tunnelInfo.userspaceTunPort && Number(tunnelInfo.userspaceTunPort) > 0)
      ? ` --userspace-port=${tunnelInfo.userspaceTunPort}`
      : ''
    const runCmd = `${udidPart} --address=${tunnelInfo.address} --rsd-port=${tunnelInfo.rsdPort}${userspacePart}${bundleIdPart}${testRunnerBundleIdPart}${xctestConfigPart} runwda`
    // ...
  }
}
```

**✅ 适配状态：完全匹配**

- `--address` 参数正确
- `--rsd-port` 参数正确
- `--userspace-port` 参数正确（可选，仅在需要时添加）

## 四、无隧道模式检查

### 4.1 代码中的使用方式

**位置**: `src/utils/ios.js` 第 3856-3858 行

```javascript
else {
  // iOS 26 无隧道：直接使用 runwda
  const runCmd = `${udidPart}${bundleIdPart}${testRunnerBundleIdPart}${xctestConfigPart} runwda`
  // ...
}
```

**✅ 适配状态：正确**

- iOS 15/16 设备不需要隧道，直接使用 `runwda` 命令
- 参数格式正确

## 五、超时时间设置

### 5.1 代码中的超时设置

**位置**: `src/utils/ios.js` 第 3809 行、第 3862 行

```javascript
const runRes = await this.execute(runCmd, { timeout: 60000 })
```

**✅ 适配状态：合理**

- 超时时间设置为 60 秒（60000 毫秒）
- 符合 `runwda` 命令长时间运行的特点
- 给 WDA 启动和初始化留出足够时间

## 六、错误检测逻辑

### 6.1 代码中的错误检测

**位置**: `src/utils/ios.js` 第 3817-3822 行

```javascript
const stderrText = runRes.stderr || ''
const hasErrorInStderr = stderrText.includes('"level":"error"') || 
                         stderrText.includes('Failed running WDA') ||
                         stderrText.includes('please specify either NONE') ||
                         stderrText.includes('At least one was empty')
```

**✅ 适配状态：完善**

- 检测 JSON 格式的错误日志（`"level":"error"`）
- 检测常见的 `runwda` 错误消息
- 检测参数不完整的错误（`please specify either NONE`）

## 七、总结

### ✅ 完全适配的功能

1. **runwda 命令参数格式** - 完全匹配 go-ios v1.0.199 的要求
2. **隧道参数** - 正确使用 `--address`、`--rsd-port`、`--userspace-port`
3. **参数完整性** - 遵循 "全部指定或全部不指定" 的规则
4. **超时设置** - 60 秒超时时间合理
5. **错误检测** - 完善的错误检测逻辑

### 📝 注意事项

1. **xcodebuild 备用方案已移除** - 根据用户要求，已移除 `xcodebuild test-without-building` 备用方案（因为打包后其他电脑可能没有 xcodebuild）
2. **只使用 runwda** - iOS 26 现在只依赖 `runwda` 命令，如果失败会直接返回错误
3. **Bundle ID 自动检测** - 代码会自动检测设备上已安装的 WDA Bundle ID，如果检测失败会使用默认值

### 🔍 建议测试

1. **iOS 26 设备测试**：
   - 测试带隧道的启动（iOS 17+）
   - 测试无隧道的启动（iOS 15/16，虽然 iOS 26 应该都需要隧道）
   - 验证 Bundle ID 自动检测功能

2. **错误场景测试**：
   - WDA 未安装时的错误处理
   - Bundle ID 检测失败时的默认值使用
   - `runwda` 命令失败时的错误信息

3. **日志验证**：
   - 确认日志中显示正确的参数格式
   - 确认错误信息清晰易懂

## 八、代码位置参考

- **iOS 26 检测**: `src/utils/ios.js` 第 3695 行
- **Bundle ID 检测**: `src/utils/ios.js` 第 3707-3773 行
- **参数构建**: `src/utils/ios.js` 第 3775-3796 行
- **带隧道启动**: `src/utils/ios.js` 第 3798-3847 行
- **无隧道启动**: `src/utils/ios.js` 第 3856-3900 行
- **错误处理**: `src/utils/ios.js` 第 4015-4030 行
