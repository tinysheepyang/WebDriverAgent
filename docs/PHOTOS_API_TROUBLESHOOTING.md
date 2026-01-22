# Photos API 连接问题排查指南

## 🔍 问题：无法连接到 WebDriverAgent 服务器

```
curl: (7) Failed to connect to localhost port 8100 after 0 ms: Couldn't connect to server
```

## 📋 排查步骤

### 1. 确认 WebDriverAgent 是否正在运行

#### 方法 A: 检查 Xcode 控制台
在 Xcode 中运行 WebDriverAgentRunner，查看控制台输出，应该看到：
```
ServerURLHere->http://IP:PORT<-ServerURLHere
```

#### 方法 B: 检查进程
```bash
# 检查是否有 WebDriverAgent 进程
ps aux | grep WebDriverAgent

# 检查端口是否被占用
lsof -i :8100
```

### 2. 确认正确的服务器地址

WebDriverAgent 的服务器地址取决于运行环境：

#### 模拟器 (Simulator)
- **地址**: `http://127.0.0.1:8100` 或 `http://localhost:8100`
- **端口**: 默认 8100（可通过 USE_PORT 环境变量修改）

#### 真机 (Real Device)
- **地址**: `http://设备WiFiIP:8100`
- **端口**: 默认 8100
- **注意**: 不能使用 `localhost`，必须使用设备的实际 IP 地址

### 3. 获取正确的服务器地址

#### 从 Xcode 控制台获取
运行 WebDriverAgent 时，控制台会输出：
```
ServerURLHere->http://192.168.1.100:8100<-ServerURLHere
```

#### 从设备获取 IP
```bash
# 在设备上查看 WiFi IP
# 设置 > WiFi > 点击已连接的 WiFi > 查看 IP 地址
```

#### 通过 usbmuxd 端口转发（真机）
如果设备通过 USB 连接，可以使用端口转发：
```bash
# 安装 usbmuxd (如果还没有)
brew install usbmuxd

# 端口转发
iproxy 8100 8100

# 然后可以使用 localhost
curl "http://localhost:8100/photos/assets?limit=10&offset=0"
```

### 4. 测试连接

#### 测试基本连接
```bash
# 模拟器
curl "http://localhost:8100/status"

# 真机（使用设备 IP）
curl "http://192.168.1.100:8100/status"

# 真机（使用端口转发）
iproxy 8100 8100 &
curl "http://localhost:8100/status"
```

#### 测试 Photos API
```bash
# 健康检查
curl "http://localhost:8100/photos/health"

# 获取照片列表
curl "http://localhost:8100/photos/assets?limit=10&offset=0"
```

### 5. 常见问题解决

#### 问题 1: 连接被拒绝
**原因**: WebDriverAgent 没有运行或端口不对

**解决**:
1. 确认 WebDriverAgent 正在运行
2. 检查 Xcode 控制台的服务器 URL
3. 确认端口号正确

#### 问题 2: 真机无法连接
**原因**: 使用了 localhost 而不是设备 IP

**解决**:
1. 获取设备的 WiFi IP 地址
2. 使用设备 IP 而不是 localhost
3. 或使用 `iproxy` 进行端口转发

#### 问题 3: 端口被占用
**原因**: 8100 端口被其他程序占用

**解决**:
```bash
# 查找占用端口的进程
lsof -i :8100

# 杀死进程（如果需要）
kill -9 <PID>

# 或使用其他端口
# 在启动 WebDriverAgent 时设置 USE_PORT 环境变量
```

#### 问题 4: 防火墙阻止
**原因**: 防火墙阻止了连接

**解决**:
1. 检查 macOS 防火墙设置
2. 确保允许本地网络连接
3. 对于真机，确保设备和 Mac 在同一网络

### 6. 快速诊断脚本

创建 `test-wda-connection.sh`:

```bash
#!/bin/bash

echo "=== WebDriverAgent 连接测试 ==="
echo ""

# 检查端口是否开放
echo "1. 检查端口 8100..."
if lsof -i :8100 > /dev/null 2>&1; then
    echo "   ✅ 端口 8100 已被占用（可能是 WDA）"
    lsof -i :8100
else
    echo "   ❌ 端口 8100 未被占用（WDA 可能未运行）"
fi

echo ""
echo "2. 测试 localhost:8100..."
if curl -s -o /dev/null -w "%{http_code}" "http://localhost:8100/status" | grep -q "200"; then
    echo "   ✅ localhost:8100 可访问"
    echo "   响应:"
    curl -s "http://localhost:8100/status" | python3 -m json.tool
else
    echo "   ❌ localhost:8100 不可访问"
fi

echo ""
echo "3. 测试 Photos API..."
if curl -s -o /dev/null -w "%{http_code}" "http://localhost:8100/photos/health" | grep -q "200"; then
    echo "   ✅ Photos API 可访问"
    echo "   响应:"
    curl -s "http://localhost:8100/photos/health" | python3 -m json.tool
else
    echo "   ❌ Photos API 不可访问"
    echo "   状态码: $(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8100/photos/health")"
fi

echo ""
echo "=== 测试完成 ==="
```

使用方法：
```bash
chmod +x test-wda-connection.sh
./test-wda-connection.sh
```

### 7. 使用端口转发（真机推荐）

对于真机，推荐使用 `iproxy` 进行端口转发：

```bash
# 安装（如果还没有）
brew install libimobiledevice

# 启动端口转发（在后台运行）
iproxy 8100 8100 &

# 现在可以使用 localhost
curl "http://localhost:8100/photos/assets?limit=10&offset=0"

# 停止端口转发
pkill iproxy
```

### 8. 检查 WebDriverAgent 日志

在 Xcode 控制台中查找：
- `ServerURLHere->...<-ServerURLHere` - 服务器地址
- `Starting WebDriverAgent` - 启动信息
- 任何错误信息

### 9. 验证 Photos API 路由已注册

确认 `FBPhotosCommands` 已正确注册：

1. 检查文件是否已添加到项目
2. 检查是否编译成功
3. 测试其他端点（如 `/status`）确认服务器运行正常
4. 如果 `/status` 可用但 `/photos/health` 不可用，可能是路由未注册

## 🎯 快速检查清单

- [ ] WebDriverAgent 正在运行（Xcode 控制台有输出）
- [ ] 获取了正确的服务器地址（从控制台或设备）
- [ ] 使用了正确的端口（默认 8100）
- [ ] 真机使用了设备 IP 或端口转发
- [ ] 防火墙没有阻止连接
- [ ] `/status` 端点可以访问
- [ ] `FBPhotosCommands` 已添加到项目并编译成功

## 📝 示例：正确的连接方式

### 模拟器
```bash
# 直接使用 localhost
curl "http://localhost:8100/photos/assets?limit=10&offset=0"
```

### 真机（方法 1：使用设备 IP）
```bash
# 假设设备 IP 是 192.168.1.100
curl "http://192.168.1.100:8100/photos/assets?limit=10&offset=0"
```

### 真机（方法 2：使用端口转发，推荐）
```bash
# 启动端口转发
iproxy 8100 8100 &

# 使用 localhost
curl "http://localhost:8100/photos/assets?limit=10&offset=0"
```

## 🔧 如果仍然无法连接

1. **检查 Xcode 控制台**：查看完整的启动日志和错误信息
2. **检查网络**：确保设备和 Mac 在同一网络（真机）
3. **重启 WebDriverAgent**：停止并重新运行
4. **检查代码**：确认 `FBPhotosCommands` 已正确实现和注册
5. **查看详细错误**：使用 `curl -v` 查看详细连接信息

```bash
curl -v "http://localhost:8100/photos/health"
```
