# iOS 26 runwda 启动后退出问题分析

## 问题描述

`runwda` 命令执行后，虽然返回 `success: true`，但 stderr 中包含错误信息，且 WDA 启动后一段时间退出了。

## 错误信息

```
"please specify either NONE of bundleid, testbundleid and xctestconfig or ALL of them. At least one was empty."
```

## 根本原因

### 1. **参数不完整**

`go-ios runwda` 要求：
- **要么不指定任何参数**（使用默认值）
- **要么同时指定所有三个参数**：`--bundleid`、`--testrunnerbundleid`、`--xctestconfig`

当前代码只指定了 `--bundleid` 和 `--testrunnerbundleid`，缺少 `--xctestconfig`。

### 2. **runwda 命令的行为**

`runwda` 命令的行为特点：
- `runwda` 是一个**同步命令**，它会启动 WDA 并等待
- 如果 WDA 启动成功，`runwda` 会**保持运行**，直到 WDA 退出或被终止
- 如果 WDA 启动失败，`runwda` 会**立即退出**并返回错误
- `runwda` 的超时时间默认是 15 秒（`this.timeout`），这对于启动 WDA 来说可能太短

### 3. **WDA 进程退出**

WDA 启动后退出可能的原因：
1. **testmanagerd 未正确启动**：虽然 `runwda` 应该启动 `testmanagerd`，但可能启动失败
2. **WDA 应用崩溃**：WDA 应用在设备上启动后立即崩溃
3. **端口冲突**：8100 端口被占用或冲突
4. **签名问题**：WDA 应用的签名不完整或无效
5. **权限问题**：WDA 应用缺少必要的权限

## 修复方案

### 1. 修复参数问题

**位置：** `src/utils/ios.js` 第 3776-3797 行

- 如果指定了 `bundleid`，必须同时指定 `testrunnerbundleid` 和 `xctestconfig`
- `xctestconfig` 的默认值是 `WebDriverAgentRunner.xctest`
- 如果找不到 bundle ID，不指定任何参数，让 `runwda` 使用默认值

### 2. 增加超时时间

**位置：** `src/utils/ios.js` 第 3808 行、第 3865 行

- `runwda` 命令的超时时间从默认的 15 秒增加到 **60 秒**
- 给 WDA 启动和初始化留出足够的时间

### 3. 检查 stderr 中的错误

**位置：** `src/utils/ios.js` 第 3816-3832 行

- 即使命令返回 `success: true`，也要检查 stderr 中是否包含错误
- 如果 stderr 中包含错误（如 `"level":"error"`、`"Failed running WDA"`），视为启动失败

### 4. 验证 WDA 进程状态

**位置：** `src/utils/ios.js` 第 3969-3984 行

- 在 `runwda` 启动后，验证 WDA/testmanagerd 进程是否在设备上运行
- 如果进程不存在，说明 WDA 启动失败或已退出

## 诊断步骤

### 1. 检查 runwda 命令参数

```bash
# 手动执行 runwda 命令，查看完整输出
ios --udid=YOUR_UDID --address=... --rsd-port=... --userspace-port=... \
  --bundleid=com.facebook.WebDriverAgentRunner.xyautotest.xctrunner \
  --testrunnerbundleid=com.facebook.WebDriverAgentRunner.xyautotest \
  --xctestconfig=WebDriverAgentRunner.xctest \
  runwda
```

### 2. 检查设备日志

```bash
# 实时查看设备日志
ios syslog | grep -i "webdriver\|xctest\|testmanagerd\|crash\|error"
```

**关键信息：**
- `testmanagerd` 是否启动
- WDA 进程是否启动
- 是否有崩溃日志
- 是否有权限错误

### 3. 检查 WDA 进程状态

```bash
# 检查设备上的 WDA 进程
ios ps | grep -i "webdriver\|xctrunner\|testmanagerd"
```

### 4. 检查端口转发

```bash
# 检查本地端口转发
lsof -i :8100
```

## 修复后的代码逻辑

```javascript
// 1. 获取 bundle ID（如果找不到，使用默认值）
let wdaBundleId = 'com.facebook.WebDriverAgentRunner.xyautotest.xctrunner'
let testRunnerBundleId = 'com.facebook.WebDriverAgentRunner.xyautotest'

// 2. 如果指定了 bundle ID，必须同时指定所有三个参数
if (wdaBundleId && testRunnerBundleId) {
  bundleIdPart = ` --bundleid=${wdaBundleId}`
  testRunnerBundleIdPart = ` --testrunnerbundleid=${testRunnerBundleId}`
  xctestConfigPart = ` --xctestconfig=WebDriverAgentRunner.xctest`
} else {
  // 不指定任何参数，使用默认值
}

// 3. 执行 runwda（增加超时时间到 60 秒）
const runRes = await this.execute(runCmd, { timeout: 60000 })

// 4. 检查 stderr 中的错误
const hasErrorInStderr = stderrText.includes('"level":"error"') || 
                         stderrText.includes('Failed running WDA')
if (runRes.success && !hasErrorInStderr) {
  // 启动成功
} else {
  // 启动失败
}

// 5. 验证 WDA 进程是否在设备上运行
const psRes = await this.execute('ps')
if (psRes.stdout.includes('WebDriverAgent') || psRes.stdout.includes('testmanagerd')) {
  // 进程存在
} else {
  // 进程不存在，启动失败
}
```

## 如果修复后仍有问题

### 检查清单：

1. **确认参数完整**
   - 检查控制台日志，确认 `--xctestconfig` 参数已添加
   - 确认三个参数都正确传递

2. **检查超时时间**
   - 确认 `runwda` 的超时时间已增加到 60 秒
   - 如果 WDA 启动时间超过 60 秒，需要进一步增加超时时间

3. **检查设备日志**
   - 查看设备日志，确认 `testmanagerd` 和 WDA 进程是否启动
   - 查找崩溃日志或错误信息

4. **检查 WDA 安装**
   - 确认使用的是 `lower-wda.ipa`（iOS 26 需要）
   - 确认 WDA 已正确安装到设备上

5. **尝试不使用 bundle ID 参数**
   - 如果指定参数仍然失败，尝试不指定任何参数，让 `runwda` 使用默认值

## 相关文件

- **修复的代码：** `src/utils/ios.js`（第 3776-3832 行）
- **诊断文档：** `WebDriverAgent/Scripts/iOS26-WDA-Runtime-Diagnosis.md`
