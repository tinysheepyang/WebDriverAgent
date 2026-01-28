# iOS 26 WDA 启动问题修复

## 问题描述

iOS 26 系统下 WDA 未正常启动，导致 Companion Service 连接失败（错误码 3）。

## 根本原因

1. **testmanagerd 守护进程未启动**：iOS 26 中，`testmanagerd` 必须通过 `go-ios runwda` 或 `xcodebuild test-without-building` 启动，直接使用 `ios launch` 无法启动它
2. **端口转发冲突**：`runwda` 可能已经建立了端口转发，代码重复建立导致冲突
3. **等待时间不足**：iOS 26 需要更长的等待时间让 `testmanagerd` 和 WDA 完全启动

## 修复内容

### 1. iOS 26 使用 `runwda` 启动（而不是 `ios launch`）

**位置：** `src/utils/ios.js` 第 3679-3746 行

- iOS 26 检测到后，使用 `go-ios runwda` 启动 WDA
- 如果 `runwda` 失败，尝试使用 `xcodebuild test-without-building` 作为备用方案
- 增加了详细的日志输出，包括 `runwda` 的执行结果（stdout/stderr）

### 2. 增加进程验证

**位置：** `src/utils/ios.js` 第 3748-3763 行

- iOS 26 启动后，验证 WDA/testmanagerd 进程是否在设备上运行
- 检查进程列表，确认 `WebDriverAgent`、`xctrunner` 或 `testmanagerd` 进程存在

### 3. 智能端口转发检查

**位置：** `src/utils/ios.js` 第 3840-3865 行

- iOS 26 启动后，先检查端口 8100 是否已可用（`runwda` 可能已建立转发）
- 如果端口已可用，跳过手动端口转发
- 如果端口不可用，再手动建立端口转发

### 4. 优化等待时间

**位置：** `src/utils/ios.js` 第 3748-3763 行、第 3815-3826 行、第 3904-3915 行

- iOS 26 初始等待时间：**5秒**（让 testmanagerd 和 WDA 启动）
- iOS 26 跳过步骤 6 的额外等待（已在启动逻辑中等待）
- iOS 26 最终轮询等待时间：**25秒**（比 iOS 17+ 更长）

### 5. 详细的错误日志

**位置：** `src/utils/ios.js` 第 3693-3711 行、第 3717-3734 行

- 记录 `runwda` 命令的完整执行结果
- 输出 stdout 和 stderr（前 500 字符）
- 便于诊断启动失败的原因

## 修复后的启动流程（iOS 26）

```
1. 检查 WDA 是否已就绪（http://127.0.0.1:8100/status）
2. 启动隧道（如果需要）
3. 挂载 Developer Disk Image
4. 确保 WDA 已安装
5. 【关键】使用 go-ios runwda 启动（而不是 ios launch）
   - 这会启动 testmanagerd 守护进程
   - 然后启动 WDA 测试运行器
   - 输出详细的执行日志
6. 验证 WDA/testmanagerd 进程是否运行
7. 等待 5 秒让 testmanagerd 和 WDA 完全启动
8. 智能检查端口转发（如果 runwda 已建立，跳过手动转发）
9. 轮询检查 WDA 服务就绪（最多 25 秒）
```

## 验证修复

### 1. 查看控制台日志

应该看到以下日志：

```
[ensureWdaRunningViaLaunch] iOS 26 检测到：使用 runwda 启动（确保 testmanagerd 守护进程运行）
[ensureWdaRunningViaLaunch] iOS 26 使用 runwda（带隧道/无隧道）: ...
[ensureWdaRunningViaLaunch] iOS 26 runwda 执行结果: { success: true, ... }
[ensureWdaRunningViaLaunch] ✅ iOS 26 runwda 启动成功
[ensureWdaRunningViaLaunch] iOS 26 验证 WDA 进程状态...
[ensureWdaRunningViaLaunch] ✅ iOS 26 验证成功：WDA/testmanagerd 进程在设备上运行
[ensureWdaRunningViaLaunch] iOS 26 等待 testmanagerd 和 WDA 启动（5秒）...
[ensureWdaRunningViaLaunch] iOS 26 检查端口 8100 是否已可用（runwda 可能已建立转发）...
[ensureWdaRunningViaLaunch] ✅ iOS 26 端口 8100 已可用，runwda 已建立端口转发，跳过手动转发
[ensureWdaRunningViaLaunch] ✅ WDA 服务已就绪
```

### 2. 检查设备日志

```bash
ios syslog | grep -i "testmanagerd\|webdriver"
```

应该看到：
- `testmanagerd` 进程启动
- WDA 成功连接到 `testmanagerd`
- 不再出现 "No such process" 错误

### 3. 测试 WDA 功能

- 打开 URL（自动登录）
- 获取环境信息
- 预览照片

## 如果仍有问题

### 检查清单：

1. **确认使用的是修复后的代码**
   - 检查浏览器控制台，确认看到 "iOS 26 检测到" 的日志

2. **检查 `runwda` 执行结果**
   - 查看控制台日志中的 "iOS 26 runwda 执行结果"
   - 如果 `success: false`，查看 `error`、`stdout`、`stderr` 字段

3. **检查进程状态**
   - 查看 "iOS 26 验证 WDA 进程状态" 的日志
   - 如果未检测到进程，查看设备进程列表

4. **检查端口转发**
   - 查看 "iOS 26 检查端口 8100" 的日志
   - 如果端口不可用，查看端口转发建立的结果

5. **手动测试 `runwda`**
   ```bash
   ios runwda --udid=YOUR_DEVICE_UDID
   ```
   - 如果失败，检查 `go-ios` 版本是否支持 iOS 26

6. **检查设备设置**
   - 开发者模式已启用
   - UI Automation 已启用
   - 设备已信任开发者证书

## 相关文件

- **修复的代码：** `src/utils/ios.js`（第 3674-3915 行）
- **诊断文档：** `WebDriverAgent/Scripts/iOS26-WDA-Runtime-Diagnosis.md`
- **修复方案：** `WebDriverAgent/Scripts/iOS26-WDA-Fix-Solution.md`

## 总结

✅ **问题：** iOS 26 下 WDA 未正常启动  
✅ **原因：** testmanagerd 未启动、端口转发冲突、等待时间不足  
✅ **修复：** 使用 `runwda` 启动、智能端口转发检查、优化等待时间、增加详细日志  
✅ **状态：** 代码已修复，等待测试验证

**下一步：** 重新构建前端，在 iOS 26 设备上测试 WDA 启动功能。
