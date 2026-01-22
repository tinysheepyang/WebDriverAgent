# 设备端 HTTP 请求功能使用指南

## ✅ 功能说明

已添加 `POST /photos/http-request` 端点，可以通过 iOS 设备端发起 HTTP 请求，类似于 PhotoCompanion 的 HTTP_REQUEST 功能。

## 📋 API 端点

### POST /photos/http-request

通过设备端发起 HTTP 请求

**请求体：**
```json
{
  "url": "http://example.com/api",
  "method": "GET",
  "headers": {
    "Authorization": "Bearer token",
    "Content-Type": "application/json"
  },
  "body": "request body",
  "timeout": 15.0
}
```

**参数：**
- `url` (必需): 请求的 URL
- `method` (可选): HTTP 方法，默认 "GET"
- `headers` (可选): 请求头字典
- `body` (可选): 请求体（字符串）
- `timeout` (可选): 超时时间（秒），默认 15.0

**响应：**
```json
{
  "value": {
    "status": 200,
    "headers": {
      "Content-Type": "application/json",
      "Content-Length": "1234"
    },
    "body": "response body text"
  }
}
```

## 🚀 使用示例

### 示例 1: 测试 nohost.oa.com

```bash
curl -X POST "http://localhost:8100/photos/http-request" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://nohost.oa.com/cgi-bin/list?_=1769057220003",
    "method": "GET",
    "timeout": 10.0
  }'
```

### 示例 2: 带请求头的请求

```bash
curl -X POST "http://localhost:8100/photos/http-request" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.example.com/data",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer your-token",
      "Content-Type": "application/json"
    },
    "body": "{\"key\":\"value\"}",
    "timeout": 30.0
  }'
```

### 示例 3: 使用测试脚本

```bash
# 运行测试脚本
./test-http-request.sh
```

## 🔍 测试 nohost.oa.com 接口

### 直接测试（PC 端）
```bash
curl "http://nohost.oa.com/cgi-bin/list?_=1769057220003"
```
✅ **结果**: 可以访问，返回 200 OK，包含 107 个环境配置

### 通过设备端测试
```bash
curl -X POST "http://localhost:8100/photos/http-request" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://nohost.oa.com/cgi-bin/list?_=1769057220003",
    "method": "GET"
  }' | python3 -m json.tool
```

这将通过 iOS 设备端发起请求，可以验证：
1. 设备是否能访问该 URL
2. 设备的网络环境是否与 PC 一致
3. 是否有网络限制或防火墙

## 📝 响应格式

### 成功响应
```json
{
  "value": {
    "status": 200,
    "headers": {
      "content-type": "application/json; charset=utf-8",
      "content-length": "47624"
    },
    "body": "{\"ec\":0,\"baseUrl\":\"http://nohost.oa.com/\",...}"
  }
}
```

### 错误响应
```json
{
  "status": 13,
  "value": {
    "error": "HTTP request failed: ...",
    "message": "...",
    "traceback": "..."
  }
}
```

## ⚠️ 注意事项

1. **超时设置**: 默认超时 15 秒，大文件或慢速网络可能需要增加
2. **响应体大小**: 大响应体会增加传输时间，建议设置合理的超时
3. **二进制数据**: 如果响应不是 UTF-8 文本，会返回 base64 编码
4. **网络环境**: 设备端请求使用设备的网络环境，可能与 PC 不同

## 🔧 故障排除

### 请求超时
- 增加 `timeout` 参数
- 检查设备网络连接
- 确认目标 URL 可访问

### 连接失败
- 检查 URL 格式是否正确
- 确认设备能访问目标域名
- 检查是否有防火墙限制

### 响应为空
- 检查响应状态码
- 查看响应头信息
- 确认响应体格式

## 🎯 使用场景

1. **测试设备网络环境**: 验证设备是否能访问特定 URL
2. **代理请求**: 通过设备端发起请求，绕过 PC 端网络限制
3. **API 测试**: 测试需要设备端 Cookie 或认证的 API
4. **环境切换**: 测试不同网络环境下的 API 响应

## 📊 性能考虑

- 请求在设备端执行，受设备网络速度影响
- 大响应体需要较长时间传输
- 建议设置合理的超时时间
- 对于大文件，考虑使用流式传输（后续优化）
