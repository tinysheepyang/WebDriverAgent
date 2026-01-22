# Photos Service 实现状态

## ✅ 已完成

### 1. 架构调整
- ✅ 数据结构改为 `assetId` 为主键
- ✅ API 接口定义（流式预览）
- ✅ 前端适配（优先 Photos Service，fallback 到 PTP）
- ✅ 测试脚本和文档

### 2. libimobiledevice 集成
- ✅ 检测 libimobiledevice 是否可用
- ✅ DeviceManager 优先使用 `idevice_id`
- ✅ LibimobiledeviceWrapper 封装
- ✅ PhotosService 集成 libimobiledevice

### 3. 协议框架
- ✅ usbmuxd 客户端框架
- ✅ lockdownd 协议框架
- ✅ Photos Service 协议框架

## ⏳ 进行中

### Photos Service 协议实现

**现状**：
- libimobiledevice **不直接支持** Photos Service
- Photos Service 是 Apple 的私有协议，文档很少
- 需要通过自定义实现（usbmuxd + lockdownd + Photos Service 协议）

**下一步**：
1. 实现 usbmuxd 客户端的基础功能
2. 实现 lockdownd 协议（plist 消息处理）
3. 研究 Photos Service 协议（可能需要逆向工程）

## 📋 待实现

### Phase 1: usbmuxd 实现
- [ ] 消息序列化/反序列化
- [ ] ListDevices 消息
- [ ] Connect 消息

### Phase 2: lockdownd 实现
- [ ] plist 消息处理
- [ ] 设备配对
- [ ] StartService 消息

### Phase 3: Photos Service 协议
- [ ] 连接握手
- [ ] 获取相册列表
- [ ] 获取资源列表
- [ ] 获取缩略图
- [ ] 获取原图（流式）
- [ ] 获取视频流

### Phase 4: iOS 端集成
- [ ] PHImageManager 集成（获取图片数据）
- [ ] AVAssetReader 集成（流式读取视频）

## 🔍 研究发现

### libimobiledevice 的限制

1. **不直接支持 Photos Service**
   - libimobiledevice 主要通过文件系统访问照片（ifuse）
   - 无法获取系统生成的缩略图
   - 无法使用 PHImageManager 和 AVAssetReader

2. **Photos Service 是私有协议**
   - Apple 未公开文档
   - 需要逆向工程或参考现有实现
   - 可能随 iOS 版本变化

### 可能的方案

#### 方案 A: 自定义协议实现（当前方向）
- 实现 usbmuxd + lockdownd + Photos Service
- 优点：完全控制
- 缺点：工作量大，需要逆向工程

#### 方案 B: iOS 应用桥接
- 创建 iOS 应用，使用 PHImageManager 和 AVAssetReader
- 通过自定义协议与 PC 通信
- 优点：可以使用系统 API
- 缺点：需要开发 iOS 应用，需要安装到设备

#### 方案 C: 使用现有工具
- 研究 iMazing、爱思助手等工具的实现
- 参考其协议实现
- 优点：有参考
- 缺点：可能涉及逆向工程

## 📝 当前代码结构

```
WebDriverAgent/photo-proxy/
├── usb/
│   ├── device.ts              ✅ 设备检测（优先 libimobiledevice）
│   ├── service.ts             ✅ PhotosService 主类（集成 libimobiledevice）
│   ├── libimobiledevice.ts    ✅ FFI 绑定框架（可选）
│   ├── libimobiledevice-wrapper.ts  ✅ 命令行封装
│   ├── usbmuxd.ts             ⏳ 协议框架（待实现）
│   └── lockdownd.ts           ⏳ 协议框架（待实现）
├── photos/
│   ├── albums.ts              ✅ 相册管理（占位）
│   ├── assets.ts              ✅ 资源管理（占位）
│   ├── thumbnail.ts           ✅ 缩略图管理（占位）
│   └── protocol.ts            ⏳ Photos Service 协议（待实现）
└── server.ts                  ✅ HTTP 服务器
```

## 🚀 下一步行动

1. **研究 Photos Service 协议**
   - 查看 libimobiledevice 源码
   - 研究 go-ios 的实现
   - 参考其他工具的实现

2. **实现 usbmuxd 客户端**
   - 实现消息序列化
   - 实现 ListDevices
   - 实现 Connect

3. **实现 lockdownd 协议**
   - 实现 plist 处理
   - 实现设备配对
   - 实现 StartService

4. **实现 Photos Service 协议**
   - 研究协议格式
   - 实现各个功能

## 📚 参考资源

- libimobiledevice: https://github.com/libimobiledevice/libimobiledevice
- usbmuxd: https://github.com/libimobiledevice/usbmuxd
- The iPhone Wiki: https://www.theiphonewiki.com/
- go-ios: https://github.com/danielpaulus/go-ios
