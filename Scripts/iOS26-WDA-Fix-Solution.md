# iOS 26 WDA 无法正常工作 - 修复方案

## 一、问题根源

根据设备日志分析，**核心问题是 `com.apple.testmanagerd` 守护进程未运行**：

```
Failed to initiate daemon session: Error Domain=NSCocoaErrorDomain Code=4099 
"The connection to service named com.apple.testmanagerd was invalidated: 
Connection init failed at lookup with error 3 - No such process."
```

**原因：**

- iOS 26 中，`testmanagerd` 守护进程**只在通过 `xcodebuild test-without-building` 或 `go-ios runwda` 启动测试时才会启动**
- 直接通过 `ios launch .xctrunner` 启动**不会启动 `testmanagerd`**，导致 WDA 崩溃

---

## 二、修复方案

### 已修改的代码

**文件：** `src/utils/ios.js`  
**方法：** `ensureWdaRunningViaLaunch()`（第 3674-3739 行）

**修改内容：**

1. **检测 iOS 26**：在启动 WDA 前检查是否为 iOS 26
2. **iOS 26 使用 `runwda`**：使用 `go-ios runwda` 启动（会启动 `testmanagerd`）
3. **备用方案**：如果 `runwda` 失败，尝试使用 `xcodebuild test-without-building`
4. **iOS < 26**：保持原有逻辑（使用 `ios launch`）

---

## 三、修复后的启动流程

### iOS 26 启动流程：

```
1. 检查 WDA 是否已就绪（http://127.0.0.1:8100/status）
2. 启动隧道（如果需要）
3. 挂载 Developer Disk Image
4. 确保 WDA 已安装
5. 【关键】使用 go-ios runwda 启动（而不是 ios launch）
   - 这会启动 testmanagerd 守护进程
   - 然后启动 WDA 测试运行器
6. 建立端口转发（8100 -> 8100）
7. 等待 WDA 服务就绪
```

### iOS < 26 启动流程（保持不变）：

```
1-4. 同上
5. 使用 ios launch .xctrunner（原有方式）
6-7. 同上
```

---

## 四、验证修复

### 1. 重新构建前端代码

```bash
# 如果使用 Vite
npm run dev
# 或
npm run build
```

### 2. 测试 WDA 启动

在应用中：
1. 连接 iOS 26 设备
2. 点击"刷新设备状态"
3. 查看控制台日志，应该看到：
   ```
   [ensureWdaRunningViaLaunch] iOS 26 检测到：使用 runwda 启动（确保 testmanagerd 守护进程运行）
   [ensureWdaRunningViaLaunch] iOS 26 使用 runwda（带隧道/无隧道）: ...
   [ensureWdaRunningViaLaunch] ✅ iOS 26 runwda 启动成功
   ```

### 3. 检查设备日志

```bash
ios syslog | grep -i "testmanagerd\|webdriver"
```

**应该看到：**
- `testmanagerd` 进程启动
- WDA 成功连接到 `testmanagerd`
- 不再出现 "No such process" 错误

---

## 五、如果修复后仍有问题

### 检查清单：

1. **确认使用的是修复后的代码**
   - 检查浏览器控制台，确认看到 "iOS 26 检测到" 的日志

2. **确认 `go-ios runwda` 可用**
   ```bash
   ios runwda --udid=YOUR_DEVICE_UDID
   ```
   - 如果失败，检查 `go-ios` 版本是否支持 iOS 26

3. **如果 `runwda` 不可用，使用备用方案**
   - 代码会自动尝试 `xcodebuild test-without-building`
   - 需要确保 Xcode 已正确配置

4. **检查设备设置**
   - 开发者模式已启用
   - UI Automation 已启用
   - 设备已信任开发者证书

---

## 六、技术细节

### 为什么 `runwda` 可以工作？

`go-ios runwda` 命令内部会：
1. 启动 `testmanagerd` 守护进程（如果未运行）
2. 通过测试框架启动 WDA 测试运行器
3. 建立必要的进程间通信

而 `ios launch` 只是简单地启动应用，不会启动 `testmanagerd`。

### 为什么 iOS 26 需要 `testmanagerd`？

iOS 26 对测试运行器的安全性和隔离性要求更严格：
- 测试运行器必须通过 `testmanagerd` 进行进程间通信
- `testmanagerd` 负责管理测试会话、资源分配等
- 没有 `testmanagerd`，测试运行器无法正常工作

---

## 七、相关文件

- **修复的代码：** `src/utils/ios.js`（第 3674-3739 行）
- **诊断文档：** `WebDriverAgent/Scripts/iOS26-WDA-Runtime-Diagnosis.md`
- **构建分析：** `WebDriverAgent/Scripts/iOS26-WDA-Build-Analysis.md`

---

## 八、总结

✅ **问题：** iOS 26 上 WDA 安装后无法正常工作  
✅ **原因：** `testmanagerd` 守护进程未运行（`ios launch` 不会启动它）  
✅ **修复：** iOS 26 使用 `go-ios runwda` 启动 WDA（会启动 `testmanagerd`）  
✅ **状态：** 代码已修复，等待测试验证

**下一步：** 重新构建前端，在 iOS 26 设备上测试 WDA 启动功能。
