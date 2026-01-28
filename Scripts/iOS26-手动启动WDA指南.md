# go-ios v1.0.199 手动启动 iOS 26 WDA 指南

## 一、前置条件

### 1.1 设备准备

- ✅ iOS 26 设备已连接（USB 或 WiFi）
- ✅ 开发者模式已启用（Settings → Privacy & Security → Developer Mode）
- ✅ 设备已信任电脑（Settings → General → VPN & Device Management）
- ✅ WDA IPA 已安装到设备（`lower-wda.ipa` 或 `wda.ipa`）

### 1.2 工具准备

- ✅ go-ios v1.0.199 可执行文件（`commands/ios`）
- ✅ 已挂载 Developer Disk Image（如果需要）

---

## 二、获取必要信息

### 2.1 获取设备 UDID

```bash
# 方法 1：列出所有设备
./commands/ios list

# 方法 2：获取详细信息
./commands/ios list --details

# 输出示例：
# {"udid":"00008030-001A1D1E12345678","name":"iPhone 15 Pro","version":"26.0","model":"iPhone16,1"}
```

### 2.2 获取 WDA Bundle ID

```bash
# 列出已安装的应用
./commands/ios apps --list | grep -i webdriver

# 或查看所有应用
./commands/ios apps --list | grep -i xctrunner

# 输出示例：
# com.facebook.WebDriverAgentRunner.xyautotest.xctrunner
```

**常见 Bundle ID：**
- `com.facebook.WebDriverAgentRunner.xyautotest.xctrunner`（测试运行器）
- `com.facebook.WebDriverAgentRunner.xyautotest`（主应用，去掉 `.xctrunner` 后缀）

### 2.3 获取隧道信息（iOS 17+ 需要）

```bash
# 方法 1：使用 macOS 日志（推荐）
log stream --debug --info --predicate 'eventMessage LIKE "*Tunnel established*" OR eventMessage LIKE "*for server port*"'

# 连接设备并打开 Xcode，日志中会显示：
# Tunnel established for device: fe80::xxxx:xxxx:xxxx:xxxx%en0
# RSD port: 49152

# 方法 2：使用 go-ios tunnel 命令
./commands/ios tunnel ls

# 方法 3：检查 go-ios agent 状态
./commands/ios tunnel start
```

**隧道参数说明：**
- `--address`: IPv6 地址（如 `fe80::xxxx:xxxx:xxxx:xxxx%en0`）
- `--rsd-port`: RSD 端口（通常是 49152 或类似）
- `--userspace-port`: 用户空间隧道端口（可选，如果使用用户空间隧道）

---

## 三、启动 WDA（手动命令）

### 3.1 iOS 26 + 隧道模式（iOS 17+）

**完整命令格式：**

```bash
./commands/ios --udid=<UDID> \
  --address=<IPv6地址> \
  --rsd-port=<RSD端口> \
  [--userspace-port=<用户空间端口>] \
  --bundleid=<WDA测试运行器BundleID> \
  --testrunnerbundleid=<WDA主应用BundleID> \
  --xctestconfig=WebDriverAgentRunner.xctest \
  runwda
```

**实际示例：**

```bash
# 示例 1：使用完整参数
./commands/ios --udid=00008030-001A1D1E12345678 \
  --address=fe80::1234:5678:9abc:def0%en0 \
  --rsd-port=49152 \
  --bundleid=com.facebook.WebDriverAgentRunner.xyautotest.xctrunner \
  --testrunnerbundleid=com.facebook.WebDriverAgentRunner.xyautotest \
  --xctestconfig=WebDriverAgentRunner.xctest \
  runwda

# 示例 2：使用用户空间隧道
./commands/ios --udid=00008030-001A1D1E12345678 \
  --address=fe80::1234:5678:9abc:def0%en0 \
  --rsd-port=49152 \
  --userspace-port=49153 \
  --bundleid=com.facebook.WebDriverAgentRunner.xyautotest.xctrunner \
  --testrunnerbundleid=com.facebook.WebDriverAgentRunner.xyautotest \
  --xctestconfig=WebDriverAgentRunner.xctest \
  runwda
```

### 3.2 iOS 26 无隧道模式（iOS 15/16，但 iOS 26 通常需要隧道）

**完整命令格式：**

```bash
./commands/ios --udid=<UDID> \
  --bundleid=<WDA测试运行器BundleID> \
  --testrunnerbundleid=<WDA主应用BundleID> \
  --xctestconfig=WebDriverAgentRunner.xctest \
  runwda
```

**实际示例：**

```bash
./commands/ios --udid=00008030-001A1D1E12345678 \
  --bundleid=com.facebook.WebDriverAgentRunner.xyautotest.xctrunner \
  --testrunnerbundleid=com.facebook.WebDriverAgentRunner.xyautotest \
  --xctestconfig=WebDriverAgentRunner.xctest \
  runwda
```

### 3.3 使用默认参数（不指定 Bundle ID）

如果不想指定 Bundle ID，可以完全省略这三个参数，让 `runwda` 使用默认值：

```bash
# 带隧道
./commands/ios --udid=00008030-001A1D1E12345678 \
  --address=fe80::1234:5678:9abc:def0%en0 \
  --rsd-port=49152 \
  runwda

# 无隧道
./commands/ios --udid=00008030-001A1D1E12345678 \
  runwda
```

**⚠️ 重要提示：**
- **要么不指定任何 Bundle ID 参数**（使用默认值）
- **要么同时指定所有三个参数**：`--bundleid`、`--testrunnerbundleid`、`--xctestconfig`
- **不能只指定部分参数**，否则会报错：`"please specify either NONE of bundleid, testbundleid and xctestconfig or ALL of them"`

---

## 四、验证 WDA 启动

### 4.1 检查进程状态

```bash
# 检查设备上的进程
./commands/ios --udid=<UDID> ps | grep -i "webdriver\|xctrunner\|testmanagerd"

# 应该看到：
# WebDriverAgentRunner
# xctrunner
# testmanagerd
```

### 4.2 检查端口转发

```bash
# 检查端口转发状态
./commands/ios --udid=<UDID> forward 8100 8100

# 或检查是否已建立转发
lsof -i :8100
```

### 4.3 测试 WDA HTTP 服务

```bash
# 测试 WDA 状态接口
curl http://127.0.0.1:8100/status

# 应该返回 JSON 响应，包含 WDA 状态信息
```

### 4.4 查看设备日志

```bash
# 查看 WDA 相关日志
./commands/ios --udid=<UDID> syslog | grep -i "webdriver\|xctest\|testmanagerd"

# 应该看到：
# testmanagerd 启动成功
# WebDriverAgent 连接成功
# 没有 "No such process" 错误
```

---

## 五、常见问题排查

### 5.1 错误：`please specify either NONE of bundleid...`

**原因：** 参数不完整，只指定了部分 Bundle ID 参数。

**解决：**
- 要么完全省略所有 Bundle ID 参数（使用默认值）
- 要么同时指定所有三个参数：`--bundleid`、`--testrunnerbundleid`、`--xctestconfig`

### 5.2 错误：`Did not find test app for 'xxx' on device`

**原因：** Bundle ID 不正确或 WDA 未安装。

**解决：**
```bash
# 1. 确认 WDA 已安装
./commands/ios --udid=<UDID> apps --list | grep -i webdriver

# 2. 使用正确的 Bundle ID（通常是 .xctrunner 结尾）
# 3. 如果找不到，尝试不指定 Bundle ID 参数，使用默认值
```

### 5.3 错误：`testmanagerd` 未启动

**原因：** iOS 26 必须使用 `runwda` 启动，不能使用 `ios launch`。

**解决：**
- ✅ 使用 `runwda` 命令（会自动启动 `testmanagerd`）
- ❌ 不要使用 `ios launch` 命令

### 5.4 错误：端口 8100 被占用

**原因：** 之前的 WDA 进程仍在运行或端口转发冲突。

**解决：**
```bash
# 1. 终止之前的 WDA 进程
./commands/ios --udid=<UDID> kill com.facebook.WebDriverAgentRunner.xyautotest.xctrunner

# 2. 终止端口转发进程
lsof -ti :8100 | xargs kill -9

# 3. 重新启动 WDA
```

### 5.5 错误：无法获取隧道信息

**原因：** iOS 17+ 需要隧道，但隧道未建立。

**解决：**
```bash
# 1. 启动 go-ios tunnel agent
./commands/ios tunnel start

# 2. 或使用 macOS 系统隧道（连接设备并打开 Xcode）
# 3. 获取隧道信息（参考 2.3 节）
```

### 5.6 WDA 启动后立即退出

**可能原因：**
1. **testmanagerd 未启动**：检查进程列表，确认 `testmanagerd` 存在
2. **签名问题**：确认 WDA IPA 已正确签名
3. **权限问题**：确认开发者模式已启用
4. **端口冲突**：检查 8100 端口是否被占用

**排查步骤：**
```bash
# 1. 检查进程
./commands/ios --udid=<UDID> ps | grep -i "testmanagerd\|webdriver"

# 2. 查看详细日志
./commands/ios --udid=<UDID> syslog | grep -i "error\|crash\|webdriver" | tail -50

# 3. 检查端口
lsof -i :8100
```

---

## 六、完整启动脚本示例

### 6.1 自动化启动脚本

```bash
#!/bin/bash

# 配置变量
UDID="00008030-001A1D1E12345678"
ADDRESS="fe80::1234:5678:9abc:def0%en0"
RSD_PORT="49152"
BUNDLE_ID="com.facebook.WebDriverAgentRunner.xyautotest.xctrunner"
TEST_RUNNER_BUNDLE_ID="com.facebook.WebDriverAgentRunner.xyautotest"
XCTEST_CONFIG="WebDriverAgentRunner.xctest"
IOS_BIN="./commands/ios"

# 检查设备连接
echo "检查设备连接..."
DEVICE_INFO=$($IOS_BIN --udid=$UDID list --details)
if [ $? -ne 0 ]; then
    echo "❌ 设备未连接或 UDID 不正确"
    exit 1
fi
echo "✅ 设备已连接"

# 检查 WDA 是否已安装
echo "检查 WDA 是否已安装..."
APPS=$($IOS_BIN --udid=$UDID apps --list)
if ! echo "$APPS" | grep -q "$BUNDLE_ID"; then
    echo "❌ WDA 未安装，请先安装 WDA IPA"
    exit 1
fi
echo "✅ WDA 已安装"

# 终止之前的 WDA 进程（如果存在）
echo "终止之前的 WDA 进程..."
$IOS_BIN --udid=$UDID kill "$BUNDLE_ID" 2>/dev/null
sleep 2

# 启动 WDA
echo "启动 WDA..."
$IOS_BIN --udid=$UDID \
  --address=$ADDRESS \
  --rsd-port=$RSD_PORT \
  --bundleid=$BUNDLE_ID \
  --testrunnerbundleid=$TEST_RUNNER_BUNDLE_ID \
  --xctestconfig=$XCTEST_CONFIG \
  runwda &

RUNWDA_PID=$!
echo "runwda 进程 ID: $RUNWDA_PID"

# 等待 WDA 启动
echo "等待 WDA 启动（10秒）..."
sleep 10

# 检查进程
echo "检查 WDA 进程..."
PS_OUTPUT=$($IOS_BIN --udid=$UDID ps)
if echo "$PS_OUTPUT" | grep -q "testmanagerd\|WebDriverAgent\|xctrunner"; then
    echo "✅ WDA 进程已启动"
else
    echo "❌ WDA 进程未启动"
    exit 1
fi

# 检查端口转发
echo "检查端口转发..."
if lsof -i :8100 > /dev/null 2>&1; then
    echo "✅ 端口转发已建立"
else
    echo "建立端口转发..."
    $IOS_BIN --udid=$UDID forward 8100 8100 &
    sleep 2
fi

# 测试 WDA 服务
echo "测试 WDA 服务..."
for i in {1..30}; do
    if curl -s http://127.0.0.1:8100/status > /dev/null 2>&1; then
        echo "✅ WDA 服务已就绪"
        exit 0
    fi
    echo "等待 WDA 服务就绪... ($i/30)"
    sleep 1
done

echo "❌ WDA 服务未就绪"
exit 1
```

---

## 七、与代码实现的对比

代码中的实现（`src/utils/ios.js`）会自动处理以下步骤：

1. ✅ **自动检测 iOS 26**：根据设备版本自动选择启动方式
2. ✅ **自动获取 UDID**：从设备列表获取第一个设备
3. ✅ **自动获取 Bundle ID**：从已安装应用列表查找 WDA Bundle ID
4. ✅ **自动获取隧道信息**：调用 `getTunnelInfo()` 获取隧道参数
5. ✅ **自动验证进程**：启动后验证 `testmanagerd` 和 WDA 进程
6. ✅ **智能端口转发**：检查端口是否已可用，避免重复转发
7. ✅ **详细错误日志**：记录完整的 stdout/stderr 用于诊断

**手动启动的优势：**
- 可以精确控制每个参数
- 便于调试和排查问题
- 可以测试不同的参数组合

**代码自动启动的优势：**
- 无需手动获取参数
- 自动处理各种边界情况
- 提供详细的日志输出

---

## 八、参考文档

- [iOS26-WDA-Startup-Fix.md](./iOS26-WDA-Startup-Fix.md) - iOS 26 WDA 启动问题修复
- [iOS26-RunWDA-Exit-Analysis.md](./iOS26-RunWDA-Exit-Analysis.md) - runwda 退出问题分析
- [iOS26-go-ios-v1.0.199-适配检查.md](./iOS26-go-ios-v1.0.199-适配检查.md) - go-ios v1.0.199 适配检查报告
