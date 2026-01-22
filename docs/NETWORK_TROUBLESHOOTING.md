# 网络连接问题排查指南

## 🔍 当前错误

**错误代码**: `-1009` (`NSURLErrorNotConnectedToInternet`)  
**错误信息**: "似乎已断开与互联网的连接"

这个错误明确表示**设备未连接到互联网**。

## 📋 排查步骤

### 1. 检查设备网络连接

#### 在设备上检查：
1. **WiFi 连接**
   - 打开 **设置 > WiFi**
   - 确认已连接到 WiFi 网络
   - 检查 WiFi 图标是否显示在状态栏

2. **蜂窝数据**（如果使用）
   - 打开 **设置 > 蜂窝网络**
   - 确认蜂窝数据已开启
   - 检查是否有信号

3. **网络测试**
   - 在设备上打开 **Safari**
   - 访问 `http://www.baidu.com` 或 `http://www.apple.com`
   - 如果能正常访问，说明设备网络正常
   - 如果无法访问，说明设备确实没有网络连接

### 2. 检查 WebDriverAgent 运行环境

#### 模拟器 (Simulator)
- 模拟器使用 Mac 的网络连接
- 如果 Mac 能上网，模拟器应该也能上网
- 检查 Mac 的网络连接

#### 真机 (Real Device)
- 真机使用设备自己的网络连接
- 确保设备连接到 WiFi 或启用蜂窝数据
- 检查设备的网络设置

### 3. 测试网络诊断功能

重新编译后，运行网络诊断：

```bash
# 测试默认 URL（百度）
curl "http://localhost:8100/photos/network-diagnosis" | python3 -m json.tool

# 测试指定 URL
curl "http://localhost:8100/photos/network-diagnosis?url=http://nohost.oa.com" | python3 -m json.tool
```

### 4. 检查内网域名访问

如果 `nohost.oa.com` 是内网域名：

1. **确认设备在同一网络**
   - 设备必须连接到与服务器相同的局域网
   - 检查设备的 IP 地址是否在同一网段

2. **测试内网连接**
   - 在设备 Safari 中访问 `http://nohost.oa.com`
   - 如果能访问，说明网络正常
   - 如果无法访问，说明设备不在正确的网络环境中

3. **检查 DNS 解析**
   - 设备可能无法解析 `nohost.oa.com`
   - 尝试使用 IP 地址测试：
   ```bash
   curl -X POST "http://localhost:8100/photos/http-request" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "http://192.168.x.x/cgi-bin/list?_=1769057220003",
       "method": "GET"
     }'
   ```

### 5. 检查防火墙和代理

1. **企业网络限制**
   - 某些企业网络可能阻止测试 bundle 访问网络
   - 检查是否有防火墙规则

2. **代理设置**
   - 检查设备是否配置了代理
   - 代理可能阻止某些连接

3. **VPN**
   - 如果设备连接了 VPN，可能影响网络访问
   - 尝试断开 VPN 后测试

## 🔧 解决方案

### 方案 1: 确保设备网络正常

1. **连接 WiFi**
   ```
   设置 > WiFi > 选择网络 > 输入密码 > 连接
   ```

2. **启用蜂窝数据**（如果需要）
   ```
   设置 > 蜂窝网络 > 开启蜂窝数据
   ```

3. **测试网络**
   - 在 Safari 中访问网页
   - 确认能正常访问

### 方案 2: 检查内网访问

如果目标 URL 是内网：

1. **确认设备在同一局域网**
   - 检查设备 IP：`设置 > WiFi > 点击已连接网络 > 查看 IP 地址`
   - 确认与服务器在同一网段

2. **测试内网连接**
   - 在设备 Safari 中访问内网 URL
   - 确认能正常访问

### 方案 3: 使用 IP 地址

如果域名解析失败，尝试使用 IP 地址：

```bash
curl -X POST "http://localhost:8100/photos/http-request" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://192.168.1.100/cgi-bin/list?_=1769057220003",
    "method": "GET"
  }' | python3 -m json.tool
```

### 方案 4: 检查测试环境

如果是在测试环境中：

1. **模拟器网络**
   - 模拟器使用 Mac 的网络
   - 确保 Mac 能访问目标 URL

2. **真机网络**
   - 真机使用设备自己的网络
   - 确保设备能访问目标 URL

## 📊 诊断命令

### 完整诊断脚本

```bash
./test-network-diagnosis.sh
```

### 手动诊断

```bash
# 1. 测试设备网络（百度）
curl "http://localhost:8100/photos/network-diagnosis" | python3 -m json.tool

# 2. 测试内网域名
curl "http://localhost:8100/photos/network-diagnosis?url=http://nohost.oa.com" | python3 -m json.tool

# 3. 测试实际请求
curl -X POST "http://localhost:8100/photos/http-request" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://nohost.oa.com/cgi-bin/list?_=1769057220003",
    "method": "GET"
  }' | python3 -m json.tool
```

## ⚠️ 常见问题

### Q: 为什么设备 Safari 能访问，但 WebDriverAgent 不能？

A: 这通常是因为：
1. **测试 bundle 权限限制**：某些企业网络可能限制测试 bundle 的网络访问
2. **App Transport Security**：虽然已配置 ATS，但某些网络环境可能仍有限制
3. **网络环境差异**：WebDriverAgent 运行在测试环境中，可能与 Safari 的网络环境不同

### Q: 错误代码 -1009 是什么意思？

A: `NSURLErrorNotConnectedToInternet` (-1009) 表示：
- 设备未连接到互联网
- WiFi 或蜂窝数据未开启
- 网络连接被阻止

### Q: 如何确认设备网络是否正常？

A: 在设备上：
1. 打开 Safari
2. 访问 `http://www.baidu.com`
3. 如果能正常访问，说明网络正常
4. 如果无法访问，说明设备没有网络连接

## 🎯 下一步

1. ✅ **重新编译 WebDriverAgent**（已修复 URL 参数获取问题）
2. ✅ **在设备上测试网络连接**（Safari 访问网页）
3. ✅ **运行网络诊断**（使用修复后的诊断端点）
4. ✅ **根据诊断结果排查网络问题**

## 📝 注意事项

- 错误代码 `-1009` 是系统级别的错误，表示设备确实没有网络连接
- 这不是代码问题，而是网络环境问题
- 需要确保设备能正常访问互联网或目标内网
- 如果目标 URL 是内网，确保设备在同一局域网中
