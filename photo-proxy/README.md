# Photo Proxy Service

Phase 1 实现：iOS Photos Service 代理服务

## 架构

```
前端
  ↓ HTTP
Photo Proxy API (port 9001)
  ↓ usbmuxd + lockdownd
iPhone Photos Service
```

## API 接口

### 1. GET /photos/albums

返回相册列表

**响应：**
```json
[
  { "id": "camera_roll", "name": "所有照片", "type": "system" },
  { "id": "2025-03", "name": "2025年3月", "type": "time" }
]
```

### 2. GET /photos/albums/{id}/assets

返回相册中的资源列表（轻量信息）

**响应：**
```json
[
  {
    "assetId": "A1B2C3...",
    "type": "image",
    "width": 3024,
    "height": 4032
  }
]
```

### 3. GET /photos/thumbnail?assetId=...&size=320

获取缩略图

**参数：**
- `assetId`: 资源 ID
- `size`: 缩略图尺寸（默认 320）

**响应：**
- 成功：`200 OK`，`Content-Type: image/jpeg`
- 不可用：`204 No Content`（前端会 fallback 到 PTP）

### 4. GET /health

健康检查

## 缓存策略

- **内存缓存**：TTL 10 分钟
- **磁盘缓存**：`~/.photo-proxy/cache/{assetId}_{size}.jpg`

## Phase 1 状态

当前实现为**框架代码**，实际的 Photos Service 协议实现需要：

1. 实现 usbmuxd 客户端
2. 实现 lockdownd 协议
3. 实现 Photos Service 协议

目前 `isAvailable()` 返回 `false`，前端会自动 fallback 到 PTP 服务。

## 下一步

实现完整的 Photos Service 协议后，将提供：
- ✅ 秒出缩略图（系统生成）
- ✅ HEIC 自动转换
- ✅ 视频 poster 支持
- ✅ 按需加载
