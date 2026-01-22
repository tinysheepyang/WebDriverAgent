# PC 端代理方案

## 🔍 问题总结

经过多次尝试，测试 bundle 仍然无法获得 Wi-Fi 网络访问权限：
- 错误：`Denied over Wi-Fi interface`
- 已尝试：ATS 配置、UIBackgroundModes、URLSession 配置
- 结果：问题仍然存在

## 💡 解决方案：PC 端代理

由于测试 bundle 可能确实无法获得网络访问权限，建议实现 **PC 端代理方案**：

### 方案概述

1. **PC 端接收请求**：WebDriverAgent 接收 HTTP 请求命令
2. **PC 端执行请求**：在 PC 端使用 Node.js/Python 执行实际的 HTTP 请求
3. **返回结果**：将响应返回给 WebDriverAgent，再返回给客户端

### 优势

- ✅ 绕过测试 bundle 的网络限制
- ✅ PC 端有完整的网络访问权限
- ✅ 可以使用设备的网络环境（如果需要）
- ✅ 实现相对简单

## 🔧 实现方案

### 方案 1: 修改现有端点（推荐）

修改 `POST /photos/http-request` 端点，在 PC 端执行请求：

```objective-c
// 在 FBPhotosCommands.m 中
+ (id<FBResponsePayload>)handleHttpRequest:(FBRouteRequest *)request
{
  // 获取请求参数
  NSString *urlString = request.arguments[@"url"];
  NSString *method = request.arguments[@"method"] ?: @"GET";
  NSDictionary *headers = request.arguments[@"headers"] ?: @{};
  NSString *body = request.arguments[@"body"];
  
  // 返回一个特殊响应，指示需要在 PC 端执行
  // 或者直接在这里调用 PC 端的代理服务
  return FBResponseWithObject(@{
    @"requiresProxy": @YES,
    @"url": urlString,
    @"method": method,
    @"headers": headers,
    @"body": body ?: @""
  });
}
```

然后在 PC 端（Node.js/Python）实现代理服务。

### 方案 2: 新增代理端点

添加一个新的端点，专门用于 PC 端代理：

```objective-c
// 新增路由
[[FBRoute POST:@"/photos/http-request-proxy"].withoutSession respondWithTarget:self action:@selector(handleHttpRequestProxy:)],
```

### 方案 3: 使用现有的 HTTP 服务器

利用 WebDriverAgent 的 HTTP 服务器，在 PC 端实现一个代理服务：

1. **PC 端代理服务**（Node.js 示例）：
```javascript
const http = require('http');
const https = require('https');

// 监听 WebDriverAgent 的代理请求
function proxyHttpRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: headers
    };
    
    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}
```

2. **WebDriverAgent 调用 PC 端代理**：
```objective-c
// 通过本地 HTTP 服务调用 PC 端代理
NSURL *proxyURL = [NSURL URLWithString:@"http://127.0.0.1:8080/proxy"];
// 发送请求到 PC 端代理服务
```

## 📝 实现步骤

### 步骤 1: 创建 PC 端代理服务

创建一个简单的 Node.js 服务：

```javascript
// proxy-server.js
const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
app.use(express.json());

app.post('/proxy', async (req, res) => {
  const { url, method = 'GET', headers = {}, body } = req.body;
  
  try {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: headers
    };
    
    const proxyReq = protocol.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => { data += chunk; });
      proxyRes.on('end', () => {
        res.json({
          status: proxyRes.statusCode,
          headers: proxyRes.headers,
          body: data
        });
      });
    });
    
    proxyReq.on('error', (error) => {
      res.status(500).json({ error: error.message });
    });
    
    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(8080, () => {
  console.log('Proxy server running on http://localhost:8080');
});
```

### 步骤 2: 修改 WebDriverAgent

修改 `handleHttpRequest` 方法，调用 PC 端代理：

```objective-c
+ (id<FBResponsePayload>)handleHttpRequest:(FBRouteRequest *)request
{
  // 获取请求参数
  NSString *urlString = request.arguments[@"url"];
  NSString *method = request.arguments[@"method"] ?: @"GET";
  NSDictionary *headers = request.arguments[@"headers"] ?: @{};
  NSString *body = request.arguments[@"body"];
  
  // 调用 PC 端代理服务
  // 注意：需要通过 usbmuxd 端口转发访问 PC 端服务
  NSString *proxyURL = @"http://127.0.0.1:8080/proxy";
  
  // 构建代理请求
  NSMutableURLRequest *proxyRequest = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:proxyURL]];
  proxyRequest.HTTPMethod = @"POST";
  [proxyRequest setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  
  NSDictionary *proxyBody = @{
    @"url": urlString,
    @"method": method,
    @"headers": headers,
    @"body": body ?: @""
  };
  
  proxyRequest.HTTPBody = [NSJSONSerialization dataWithJSONObject:proxyBody options:0 error:nil];
  
  // 执行代理请求（这个请求是到本地 PC 端的，应该可以工作）
  // ...
}
```

## ⚠️ 注意事项

1. **端口转发**：PC 端代理服务需要通过 `iproxy` 或类似工具进行端口转发
2. **本地网络**：PC 端代理服务需要监听 `0.0.0.0` 或 `127.0.0.1`
3. **安全性**：PC 端代理服务应该只接受来自 WebDriverAgent 的请求

## 🎯 推荐方案

**推荐使用方案 3**（PC 端代理服务），因为：
- ✅ 实现简单
- ✅ 不需要修改太多代码
- ✅ PC 端有完整的网络访问权限
- ✅ 可以复用现有的 WebDriverAgent HTTP 服务器

## 📚 下一步

1. 创建 PC 端代理服务（Node.js/Python）
2. 修改 WebDriverAgent 的 `handleHttpRequest` 方法
3. 配置端口转发（如果需要）
4. 测试代理功能
