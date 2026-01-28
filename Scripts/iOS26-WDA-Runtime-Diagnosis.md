# iOS 26 设备上 WDA 无法正常工作 - 诊断指南

## 一、问题确认

- ✅ 编译成功（脚本不报错）
- ✅ 打包成功（IPA 已生成）
- ✅ 安装成功（IPA 已安装到设备）
- ❌ **运行时失败**（安装后无法正常工作）

**关键点：** 你**未使用 `sign-wda-ipa.sh`**，说明使用的是其他签名方式（可能是 Xcode 自动签名、其他工具、或安装时签名）。

---

## 二、iOS 26 运行时可能的问题

### 1. **测试运行器启动方式变更**（最可能）

**问题：**

iOS 26 对 **XCTest 测试运行器（.xctrunner）** 的启动方式可能有更严格的限制。

**当前代码中的启动方式：**

从 `src/utils/ios.js` 看，使用了 `go-ios` 的 `launch` 命令：

```javascript
// 第 3682 行附近
ios launch ${bundleId}  // bundleId 应该是 com.facebook.WebDriverAgentRunner.xyautotest.xctrunner
```

**iOS 26 可能的问题：**

- `.xctrunner` 包（`CFBundlePackageType: BNDL`）**不能像普通应用一样通过 `launch` 启动**
- 需要使用 `xcodebuild test-without-building` 或 `xcrun devicectl` 来启动测试运行器
- iOS 17+ 的代码显示使用了 `devicectl`（第 684-685 行），但 iOS 26 可能有额外限制

**检查方法：**

```bash
# 1. 确认 Bundle ID 是否正确（应该包含 .xctrunner 后缀）
ios list | grep -i webdriver

# 2. 尝试手动启动
ios launch com.facebook.WebDriverAgentRunner.xyautotest.xctrunner

# 3. 查看错误信息
ios syslog | grep -i "webdriver\|xctest\|error"
```

---

### 2. **构建产物缺少必要的元数据**

**问题：**

`build-for-testing` 会生成：
- `.app` 包
- `.xctestrun` 文件（包含测试配置）

**当前脚本只打包了 `.app`：**

```bash
# build-wda-ipa.sh 第 85-88 行
for app in "${APPS[@]}"; do
  cp -R "${app}" "Payload/"
done
```

**可能缺少：**

- `.xctestrun` 文件（测试运行器需要这个文件来正确启动）
- 其他元数据文件

**检查方法：**

```bash
# 解压 IPA，检查内容
unzip -l commands/wda.ipa | grep -E "xctestrun|\.app"

# 检查构建目录是否有 .xctestrun
find /tmp/derivedDataPath -name "*.xctestrun"
```

---

### 3. **iOS 26 对测试运行器的权限限制**

**问题：**

iOS 26 可能对测试运行器有额外的运行时检查：

- **开发者模式**：必须启用（Settings → Privacy & Security → Developer Mode）
- **UI Automation**：必须启用（Settings → Developer → Enable UI Automation）
- **设备信任**：必须信任开发者证书（Settings → General → VPN & Device Management）
- **网络权限**：WDA 需要本地网络权限（已在 Info.plist 中配置）

**检查清单：**

- [ ] 开发者模式已启用并重启
- [ ] UI Automation 已启用
- [ ] 开发者证书已信任
- [ ] 设备已解锁

---

### 4. **CFBundlePackageType 问题**

**问题：**

WDA Runner 的 `Info.plist` 中：

```xml
<key>CFBundlePackageType</key>
<string>BNDL</string>  <!-- 不是 APPL -->
```

**iOS 26 可能的问题：**

- 系统可能更严格地区分 `BNDL`（测试运行器）和 `APPL`（普通应用）
- `BNDL` 类型的包**不能通过普通的 `launch` 命令启动**
- 必须使用测试框架的专用启动方式

**检查方法：**

```bash
# 检查 Info.plist
unzip -p commands/wda.ipa Payload/WebDriverAgentRunner-Runner.app/Info.plist | grep -A1 CFBundlePackageType
```

---

### 5. **使用 `CODE_SIGNING_ALLOWED=NO` 的影响**

**问题：**

构建脚本使用了 `CODE_SIGNING_ALLOWED=NO`：

```bash
CODE_SIGNING_ALLOWED=NO ARCHS=arm64
```

**这意味着：**

- 构建时**没有签名**
- 如果后续签名不完整（比如只签了主 app，没签 Frameworks），iOS 26 会拒绝加载

**即使你用了其他签名方式，也要确保：**

- ✅ 主 app 已签名
- ✅ Frameworks 内的所有框架都已签名
- ✅ PlugIns（如果有）都已签名
- ✅ Entitlements 正确（特别是 `get-task-allow`）

**检查方法：**

```bash
# 检查签名状态
codesign -vvv --deep --strict Payload/WebDriverAgentRunner-Runner.app

# 检查 entitlements
codesign -d --entitlements - Payload/WebDriverAgentRunner-Runner.app
```

---

## 三、诊断步骤

### 步骤 1：确认安装状态

```bash
# 检查是否已安装
ios list | grep -i webdriver

# 应该看到类似：
# com.facebook.WebDriverAgentRunner.xyautotest.xctrunner
```

### 步骤 2：检查设备日志

```bash
# 实时查看设备日志
ios syslog | grep -i "webdriver\|xctest\|crash\|error" > wda-ios26-log.txt

# 或使用 idevicesyslog（如果安装了 libimobiledevice）
idevicesyslog | grep -i webdriver > wda-ios26-log.txt
```

**关键错误信息：**

- `code signature invalid` → 签名问题
- `library not loaded` → 框架加载失败
- `test runner hung` → 测试运行器启动失败
- `bundle identifier not found` → Bundle ID 问题
- `entitlements` → 权限问题

### 步骤 3：尝试手动启动

```bash
# 方法1：使用 go-ios launch（可能失败）
ios launch com.facebook.WebDriverAgentRunner.xyautotest.xctrunner

# 方法2：使用 xcodebuild test-without-building（推荐）
xcodebuild test-without-building \
  -project WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination "id=YOUR_DEVICE_UDID"

# 方法3：使用 xcrun devicectl（iOS 17+）
xcrun devicectl device process launch \
  --device YOUR_DEVICE_UDID \
  com.facebook.WebDriverAgentRunner.xyautotest.xctrunner
```

### 步骤 4：检查构建产物

```bash
# 解压 IPA
unzip -q commands/wda.ipa -d /tmp/wda-check

# 检查结构
ls -la /tmp/wda-check/Payload/WebDriverAgentRunner-Runner.app/

# 检查是否有 .xctestrun 文件（应该在构建目录，不在 IPA 中）
find /tmp/derivedDataPath -name "*.xctestrun"
```

### 步骤 5：验证签名完整性

```bash
# 检查主 app
codesign -vvv --deep --strict /tmp/wda-check/Payload/WebDriverAgentRunner-Runner.app

# 检查 Frameworks（如果有）
find /tmp/wda-check/Payload/WebDriverAgentRunner-Runner.app/Frameworks -name "*.framework" -exec codesign -vvv {} \;

# 检查 entitlements
codesign -d --entitlements - /tmp/wda-check/Payload/WebDriverAgentRunner-Runner.app
```

---

## 四、可能的解决方案

### 方案 1：使用正确的启动方式（iOS 26 推荐）

**问题：** `ios launch` 可能无法启动 `.xctrunner` 包

**解决：** 修改启动逻辑，使用 `xcodebuild test-without-building` 或 `devicectl`

**参考代码位置：** `src/utils/ios.js` 第 3670-3700 行附近

**建议修改：**

```javascript
// 对于 iOS 26，使用 xcodebuild test-without-building
if (iosVersion >= 26) {
  // 使用 xcodebuild 启动测试运行器
  const testCmd = `xcodebuild test-without-building \
    -project WebDriverAgent.xcodeproj \
    -scheme WebDriverAgentRunner \
    -destination "id=${deviceId}"`
  // ...
} else {
  // iOS < 26 使用原有方式
  ios launch ${bundleId}
}
```

---

### 方案 2：确保包含 .xctestrun 文件

**问题：** IPA 中可能缺少 `.xctestrun` 文件

**解决：** 修改构建脚本，将 `.xctestrun` 也打包进去（虽然通常不需要，但可以尝试）

---

### 方案 3：检查并修复签名

**即使你没用 sign-wda-ipa.sh，也要确保：**

1. **所有组件都已签名**：
   ```bash
   # 检查签名
   codesign -vvv --deep --strict Payload/WebDriverAgentRunner-Runner.app
   ```

2. **Entitlements 正确**：
   ```bash
   # 检查 entitlements
   codesign -d --entitlements - Payload/WebDriverAgentRunner-Runner.app
   # 应该包含 get-task-allow: true
   ```

3. **如果签名不完整，重新签名**：
   ```bash
   # 使用你的签名方式重新签名所有组件
   ```

---

### 方案 4：尝试保留 XC* 框架的版本

**问题：** 删除 XC* 后依赖系统框架，iOS 26 的系统框架可能不兼容

**解决：** 使用 `build-wda-ipa-keep-xc.sh` 构建，保留 XCTest/XCUI* 框架

```bash
bash Scripts/build-wda-ipa-keep-xc.sh
```

---

### 方案 5：使用 Xcode 直接构建和运行

**验证方法：**

1. 在 Xcode 中打开 `WebDriverAgent.xcodeproj`
2. 选择正确的 provisioning profile
3. 选择设备，运行 `WebDriverAgentRunner` scheme
4. 如果 Xcode 能成功运行，说明问题在**打包/安装/启动流程**
5. 如果 Xcode 也失败，说明问题在**工程配置或 iOS 26 兼容性**

---

## 五、需要你提供的信息

为了更准确地诊断，请提供：

1. **具体的错误表现**：
   - 安装后点击图标没反应？
   - 启动后立即崩溃？
   - 启动后无法连接（端口 8100 无响应）？
   - 其他错误？

2. **设备日志**：
   ```bash
   ios syslog | grep -i "webdriver\|xctest\|crash" > error.log
   # 或
   idevicesyslog | grep -i webdriver > error.log
   ```

3. **签名方式**：
   - 你实际使用的签名工具/方法是什么？
   - 是 Xcode 自动签名，还是手动 codesign，还是其他工具？

4. **启动方式**：
   - 你是如何启动 WDA 的？
   - 使用 `ios launch` 还是其他方式？

5. **构建脚本**：
   - 使用的是 `build-wda-ipa.sh` 还是 `build-wda-ipa-keep-xc.sh`？

---

## 六、快速检查清单

- [ ] 检查设备日志，确认具体错误信息
- [ ] 验证签名完整性（`codesign -vvv --deep --strict`）
- [ ] 确认 Bundle ID 正确（包含 `.xctrunner` 后缀）
- [ ] 检查设备设置（开发者模式、UI Automation、信任证书）
- [ ] 尝试使用 `xcodebuild test-without-building` 启动
- [ ] 尝试保留 XC* 框架的版本（`build-wda-ipa-keep-xc.sh`）
- [ ] 在 Xcode 中直接运行，看是否成功
