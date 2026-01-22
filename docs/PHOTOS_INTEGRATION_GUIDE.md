# Photo-Proxy 集成完成指南

## ✅ 已完成的工作

1. ✅ 创建了 `FBPhotosCommands.h` 和 `FBPhotosCommands.m` 文件
2. ✅ 实现了以下 API 端点：
   - `GET /photos/assets` - 获取照片资源列表
   - `GET /photos/asset/:assetId/thumbnail` - 获取缩略图
   - `GET /photos/asset/:assetId/image` - 获取原图
   - `GET /photos/asset/:assetId/video/stream` - 获取视频流
   - `GET /photos/health` - 健康检查
3. ✅ 修改了 `Info.plist` 添加照片权限

## 📋 需要完成的步骤

### 1. 将文件添加到 Xcode 项目

由于项目文件（project.pbxproj）是二进制格式，需要通过 Xcode 添加文件：

1. 打开 `WebDriverAgent.xcodeproj`
2. 在项目导航器中，找到 `WebDriverAgentLib/Commands` 文件夹
3. 右键点击 `Commands` 文件夹，选择 "Add Files to WebDriverAgent..."
4. 选择以下文件：
   - `WebDriverAgentLib/Commands/FBPhotosCommands.h`
   - `WebDriverAgentLib/Commands/FBPhotosCommands.m`
5. 确保勾选：
   - ✅ "Copy items if needed" (如果文件不在项目目录中)
   - ✅ "Add to targets: WebDriverAgentLib"
6. 点击 "Add"

### 2. 验证框架依赖

Photos 框架应该已经包含在 iOS SDK 中，但需要确认：

1. 选择项目根节点 "WebDriverAgent"
2. 选择 Target "WebDriverAgentLib"
3. 进入 "Build Phases" 标签
4. 展开 "Link Binary With Libraries"
5. 确认 `Photos.framework` 和 `AVFoundation.framework` 已添加
6. 如果没有，点击 "+" 添加它们

### 3. 编译项目

1. 选择 Scheme: `WebDriverAgentRunner`
2. 选择目标设备（真机或模拟器）
3. 按 `Cmd + B` 编译
4. 检查是否有编译错误

### 4. 测试 API

启动 WebDriverAgent 后，可以通过以下方式测试：

#### 获取照片列表
```bash
curl "http://localhost:8100/photos/assets?limit=10&offset=0"
```

#### 获取缩略图
```bash
# 先获取 assetId，然后：
curl "http://localhost:8100/photos/asset/{assetId}/thumbnail?size=320"
```

#### 健康检查
```bash
curl "http://localhost:8100/photos/health"
```

## 🔧 功能说明

### API 端点详情

#### 1. GET /photos/assets
获取照片资源列表

**参数：**
- `limit` (可选): 返回数量，默认 200
- `offset` (可选): 偏移量，默认 0

**响应：**
```json
{
  "value": {
    "total": 1234,
    "items": [
      {
        "assetId": "F4C8B9A1-2C3D-4E5F-ABCD-1234567890",
        "type": "image",
        "width": 4032,
        "height": 3024,
        "creationTime": 1710937200
      }
    ]
  }
}
```

#### 2. GET /photos/asset/:assetId/thumbnail
获取缩略图

**参数：**
- `assetId` (路径参数): 资源 ID
- `size` (查询参数，可选): 缩略图尺寸，默认 320

**响应：**
```json
{
  "value": {
    "data": "base64_encoded_jpeg_data",
    "format": "jpeg",
    "size": 24567
  }
}
```

#### 3. GET /photos/asset/:assetId/image
获取原图

**参数：**
- `assetId` (路径参数): 资源 ID
- `quality` (查询参数，可选): "full" 或 "screen"，默认 "full"
- `format` (查询参数，可选): "jpeg" 或 "heic"，默认 "jpeg"

**响应：**
```json
{
  "value": {
    "data": "base64_encoded_image_data",
    "format": "jpeg",
    "size": 2456789
  }
}
```

#### 4. GET /photos/asset/:assetId/video/stream
获取视频流

**参数：**
- `assetId` (路径参数): 资源 ID

**响应：**
```json
{
  "value": {
    "data": "base64_encoded_video_data",
    "format": "mp4",
    "size": 12345678
  }
}
```

#### 5. GET /photos/health
健康检查

**响应：**
```json
{
  "value": {
    "status": "ok",
    "photoLibraryAuthorization": "authorized"
  }
}
```

## ⚠️ 注意事项

### 权限处理
- 首次访问照片库时，系统会弹出权限请求
- 如果权限被拒绝，API 会返回错误信息
- 需要在设备的 "设置 > 隐私 > 照片" 中手动授权

### 性能考虑
- 当前实现使用 base64 编码返回二进制数据，会增加约 33% 的数据量
- 对于大文件（如视频），建议后续优化为流式传输
- 缩略图已优化为 ≤ 30KB

### 限制
- 视频流当前返回完整文件，对于大文件可能较慢
- 建议后续实现真正的流式传输
- HEIC 格式会自动转换为 JPEG

## 🚀 后续优化建议

1. **二进制数据直接返回**
   - 创建自定义 `FBResponsePayload` 实现
   - 直接返回二进制数据，避免 base64 编码

2. **流式传输**
   - 实现真正的视频流式传输
   - 支持 Range 请求（HTTP 206 Partial Content）

3. **缓存机制**
   - 实现内存缓存（已准备，待实现）
   - 实现磁盘缓存

4. **预取机制**
   - 实现缩略图预取
   - 优化列表滚动性能

## 📝 代码位置

- 头文件: `WebDriverAgentLib/Commands/FBPhotosCommands.h`
- 实现文件: `WebDriverAgentLib/Commands/FBPhotosCommands.m`
- Info.plist: `WebDriverAgentRunner/Info.plist`

## 🐛 故障排除

### 编译错误
- 确保 Photos.framework 和 AVFoundation.framework 已链接
- 检查文件是否正确添加到项目中

### 运行时错误
- 检查照片权限是否已授予
- 查看 Xcode 控制台日志
- 确认设备/模拟器中有照片

### API 返回错误
- 检查 assetId 是否正确
- 确认资源类型（图片/视频）是否匹配
- 查看日志中的详细错误信息
