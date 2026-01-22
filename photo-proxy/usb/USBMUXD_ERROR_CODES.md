# usbmuxd 错误代码说明

## 常见错误代码

- `Number: 0` - 成功
- `Number: 1` - 连接被拒绝（Connection refused）
- `Number: 2` - 服务不可用（Service unavailable）
- `Number: 3` - 设备未找到（Device not found）

## Number: 1 错误

当收到 `Number: 1` 错误时，通常意味着：

1. **端口未监听**：目标端口上没有服务在监听
2. **连接被拒绝**：服务拒绝了连接请求
3. **防火墙阻止**：系统防火墙阻止了连接

## 针对 iOS Companion Service

如果连接到端口 12345 时收到 `Number: 1` 错误：

1. **检查 iOS 应用是否运行**：
   - 在 Xcode 控制台查看是否有 "Listener ready" 日志
   - 确认应用正在运行

2. **检查端口监听**：
   - iOS 应用应该监听端口 12345
   - 确认没有其他应用占用该端口

3. **检查连接日志**：
   - 查看是否有 "New connection received" 日志
   - 如果没有，说明连接没有到达 iOS 应用

4. **可能的解决方案**：
   - 重启 iOS 应用
   - 检查网络权限配置
   - 尝试使用不同的端口
