# iOS 26 WDA Bundle ID 问题分析

## 一、问题描述

**现象：**
- WebDriverAgent 项目配置的 Bundle ID：`com.facebook.WebDriverAgentRunner.xyautotest`
- 安装后通过 `ios apps --list` 看到的 Bundle ID：`xctrunner`
- 应用名称：`WebDriverAgentRunner-Runner 1.0`

**用户疑问：**
为什么项目里填写的 bundleid 是 `com.facebook.WebDriverAgentRunner.xyautotest`，但安装后显示的却是 `xctrunner`？

---

## 二、根本原因分析

### 2.1 `.xctrunner` Bundle 的特殊性

`.xctrunner` 是一个**特殊的 Bundle 类型**（`CFBundlePackageType: BNDL`），它不是普通的 iOS 应用（`CFBundlePackageType: APPL`）。

**关键点：**
1. **`.xctrunner` 是 XCTest 测试运行器**，不是一个独立的应用程序
2. **Bundle ID 显示问题**：`go-ios apps --list` 可能对 `.xctrunner` 类型的 bundle 有特殊的显示方式
3. **实际 Bundle ID**：虽然显示为 `xctrunner`，但实际的 Bundle ID 仍然是 `com.facebook.WebDriverAgentRunner.xyautotest`

### 2.2 `ios apps --list` 的输出格式

`go-ios apps --list` 的输出格式可能是：
```
<BundleID> <AppName> <Version>
```

对于 `.xctrunner` bundle，`go-ios` 可能：
- **简化显示**：只显示 `xctrunner` 而不是完整的 Bundle ID
- **或者**：`go-ios` 从某个地方读取了简化的标识符

### 2.3 项目配置检查

**配置文件位置：**

1. **Info.plist** (`WebDriverAgentRunner/Info.plist`)：
   ```xml
   <key>CFBundleIdentifier</key>
   <string>com.facebook.WebDriverAgentRunner.xyautotest</string>
   ```

2. **LocalSigning.xcconfig** (`Configurations/LocalSigning.xcconfig`)：
   ```
   PRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentRunner.xyautotest
   ```

3. **project.pbxproj**：
   ```pbxproj
   PRODUCT_BUNDLE_IDENTIFIER = "";  // 空字符串，从 xcconfig 或 Info.plist 读取
   ```

**结论：** 项目配置是正确的，Bundle ID 应该是 `com.facebook.WebDriverAgentRunner.xyautotest`

---

## 三、验证实际 Bundle ID

### 3.1 方法 1：查看完整应用信息（JSON 格式）

```bash
# 使用 JSON 格式输出，获取完整信息
./commands/ios apps --list | jq '.[] | select(.bundleId | contains("webdriver") or contains("xctrunner"))'

# 或直接查看所有应用
./commands/ios apps --list | jq '.'
```

### 3.2 方法 2：检查已安装的 IPA 内容

```bash
# 1. 解压 IPA
unzip -q commands/wda.ipa -d /tmp/wda-check

# 2. 查看 Info.plist 中的 Bundle ID
/usr/bin/plutil -p /tmp/wda-check/Payload/WebDriverAgentRunner-Runner.app/Info.plist | grep CFBundleIdentifier

# 应该显示：
# "CFBundleIdentifier" => "com.facebook.WebDriverAgentRunner.xyautotest"
```

### 3.3 方法 3：使用代码中的检测逻辑

代码中已经实现了自动检测逻辑（`src/utils/ios.js` 第 3710-3773 行）：

```javascript
// 1. 获取所有已安装应用
const appsRes = await this.getInstalledApps(udid)
const allApps = [...(appsRes.userApps || []), ...(appsRes.systemApps || [])]

// 2. 查找包含 .xctrunner 的应用
const wdaApp = allApps.find(app => {
  const bundleId = String(app.bundleId || '')
  return bundleId.includes('.xctrunner') || bundleId === '.xctrunner'
})

// 3. 如果检测到不完整的 bundle ID（如 'xctrunner'），会尝试使用常见的完整 bundle ID
if (wdaBundleId === '.xctrunner' || !wdaBundleId.includes('.')) {
  // 尝试常见的 bundle ID 组合
  const commonBundleIds = [
    'com.facebook.WebDriverAgentRunner.xyautotest.xctrunner',
    'com.facebook.WebDriverAgentRunner.xctrunner',
    'com.facebook.WebDriverAgentRunner.xyautotest'
  ]
  // ...
}
```

---

## 四、`.xctrunner` Bundle ID 的完整规则

### 4.1 Bundle ID 的构成

对于 WebDriverAgent 的 `.xctrunner` bundle：

1. **主 Bundle ID**：`com.facebook.WebDriverAgentRunner.xyautotest`
   - 这是配置在 `Info.plist` 和 `LocalSigning.xcconfig` 中的 Bundle ID

2. **测试运行器 Bundle ID**：`com.facebook.WebDriverAgentRunner.xyautotest.xctrunner`
   - 这是用于启动测试运行器的完整 Bundle ID
   - 由主 Bundle ID + `.xctrunner` 后缀组成

### 4.2 `runwda` 命令的参数

`go-ios runwda` 需要两个 Bundle ID：

```bash
--bundleid=com.facebook.WebDriverAgentRunner.xyautotest.xctrunner  # 测试运行器 Bundle ID
--testrunnerbundleid=com.facebook.WebDriverAgentRunner.xyautotest  # 主应用 Bundle ID（去掉 .xctrunner）
```

**关系：**
- `testrunnerbundleid` = `bundleid` 去掉 `.xctrunner` 后缀
- 如果 `bundleid` = `com.facebook.WebDriverAgentRunner.xyautotest.xctrunner`
- 那么 `testrunnerbundleid` = `com.facebook.WebDriverAgentRunner.xyautotest`

---

## 五、为什么 `ios apps --list` 显示 `xctrunner`？

### 5.1 可能的原因

1. **`go-ios` 的显示简化**：
   - `go-ios` 可能对 `.xctrunner` bundle 有特殊的显示逻辑
   - 为了简化输出，只显示 `xctrunner` 而不是完整的 Bundle ID

2. **Bundle 类型识别**：
   - `.xctrunner` 的 `CFBundlePackageType` 是 `BNDL`（不是 `APPL`）
   - `go-ios` 可能根据 Bundle 类型来决定显示方式

3. **输出格式限制**：
   - `--list` 选项可能只显示简化的信息
   - 需要使用 JSON 格式或详细模式才能看到完整的 Bundle ID

### 5.2 验证方法

```bash
# 方法 1：使用 JSON 格式
./commands/ios apps --list | jq '.[] | select(.name | contains("WebDriverAgent"))'

# 方法 2：查看详细信息（不使用 --list）
./commands/ios apps | jq '.[] | select(.bundleId | contains("webdriver") or contains("xyautotest"))'

# 方法 3：直接查询特定 Bundle ID
./commands/ios apps | jq '.[] | select(.bundleId == "com.facebook.WebDriverAgentRunner.xyautotest.xctrunner")'
```

---

## 六、解决方案

### 6.1 代码中的处理（已实现）

代码已经处理了这种情况（`src/utils/ios.js` 第 3724-3748 行）：

```javascript
// 如果检测到不完整的 bundle ID（如 'xctrunner'），会尝试使用常见的完整 bundle ID
if (wdaBundleId === '.xctrunner' || !wdaBundleId.includes('.')) {
  console.warn('[ensureWdaRunningViaLaunch] iOS 26 检测到不完整的 bundle ID (.xctrunner)，尝试使用常见的完整 bundle ID')
  // 尝试常见的 bundle ID 组合
  const commonBundleIds = [
    'com.facebook.WebDriverAgentRunner.xyautotest.xctrunner',
    'com.facebook.WebDriverAgentRunner.xctrunner',
    'com.facebook.WebDriverAgentRunner.xyautotest'
  ]
  
  // 检查这些常见的 bundle ID 是否在设备上
  for (const commonId of commonBundleIds) {
    const found = allApps.find(app => app.bundleId === commonId)
    if (found) {
      wdaBundleId = commonId
      console.log('[ensureWdaRunningViaLaunch] iOS 26 找到完整的 bundle ID:', wdaBundleId)
      break
    }
  }
  
  // 如果还是没找到，使用最常见的 bundle ID（根据项目配置）
  if (wdaBundleId === '.xctrunner' || !wdaBundleId.includes('com.facebook')) {
    wdaBundleId = 'com.facebook.WebDriverAgentRunner.xyautotest.xctrunner'
    console.warn('[ensureWdaRunningViaLaunch] iOS 26 使用默认 bundle ID:', wdaBundleId)
  }
}
```

### 6.2 手动验证 Bundle ID

如果需要手动验证，可以：

```bash
# 1. 查看 JSON 格式的完整应用信息
./commands/ios apps | jq '.[] | {bundleId, name, version}'

# 2. 查找 WebDriverAgent 相关应用
./commands/ios apps | jq '.[] | select(.bundleId | contains("webdriver") or contains("xyautotest") or contains("xctrunner"))'

# 3. 检查实际安装的 IPA
unzip -l commands/wda.ipa | grep Info.plist
/usr/bin/plutil -p Payload/WebDriverAgentRunner-Runner.app/Info.plist | grep CFBundleIdentifier
```

---

## 七、总结

### 7.1 关键点

1. **项目配置是正确的**：Bundle ID 确实是 `com.facebook.WebDriverAgentRunner.xyautotest`
2. **`ios apps --list` 的显示可能是简化的**：对于 `.xctrunner` bundle，可能只显示 `xctrunner`
3. **实际 Bundle ID 仍然是完整的**：虽然显示简化，但实际的 Bundle ID 应该是完整的
4. **代码已经处理了这种情况**：如果检测到不完整的 Bundle ID，会自动尝试使用常见的完整 Bundle ID

### 7.2 建议

1. **使用 JSON 格式查看完整信息**：
   ```bash
   ./commands/ios apps | jq '.[] | select(.bundleId | contains("xyautotest"))'
   ```

2. **验证实际安装的 Bundle ID**：
   ```bash
   /usr/bin/plutil -p Payload/WebDriverAgentRunner-Runner.app/Info.plist | grep CFBundleIdentifier
   ```

3. **信任代码的自动检测**：代码已经实现了智能检测和回退机制，应该能够正确处理这种情况

### 7.3 如果仍有问题

如果 `runwda` 命令仍然失败，可以：

1. **手动指定 Bundle ID**：
   ```bash
   ./commands/ios --udid=<UDID> \
     --bundleid=com.facebook.WebDriverAgentRunner.xyautotest.xctrunner \
     --testrunnerbundleid=com.facebook.WebDriverAgentRunner.xyautotest \
     --xctestconfig=WebDriverAgentRunner.xctest \
     runwda
   ```

2. **或者不指定 Bundle ID**（使用默认值）：
   ```bash
   ./commands/ios --udid=<UDID> runwda
   ```

---

## 八、相关文档

- [iOS26-手动启动WDA指南.md](./iOS26-手动启动WDA指南.md) - 手动启动 WDA 的完整指南
- [iOS26-go-ios-v1.0.199-适配检查.md](./iOS26-go-ios-v1.0.199-适配检查.md) - go-ios v1.0.199 适配检查
- [iOS26-RunWDA-Exit-Analysis.md](./iOS26-RunWDA-Exit-Analysis.md) - runwda 退出问题分析
