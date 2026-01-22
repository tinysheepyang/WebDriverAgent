# iOS Companion Service 通信协议

## 概述

PC Bridge Service 与 iOS Companion Service 之间的通信协议。

## 协议格式

### 消息结构

```
[消息头: 8 字节][JSON Payload][二进制数据（可选）]
```

### 消息头格式

- **字节 0-3**: 消息类型（uint32，大端序）
- **字节 4-7**: JSON Payload 长度（uint32，大端序）

### 消息类型

#### 请求类型
- `1`: LIST_ASSETS - 获取资源列表
- `2`: GET_THUMBNAIL - 获取缩略图
- `3`: GET_IMAGE - 获取原图
- `4`: GET_VIDEO_STREAM - 获取视频流

#### 响应类型
- `100`: RESPONSE_SUCCESS - 成功响应
- `101`: RESPONSE_ERROR - 错误响应

#### 流式数据
- `200`: STREAM_CHUNK - 流式数据块
- `201`: STREAM_END - 流结束

## 消息格式

### LIST_ASSETS 请求

```json
{
  "messageId": 1,
  "limit": 200,
  "offset": 0
}
```

### LIST_ASSETS 响应

```json
{
  "messageId": 1,
  "total": 1234,
  "items": [
    {
      "assetId": "F4C8B9A1-2C3D-4E5F-ABCD-1234567890",
      "type": "image",
      "subtype": ["live"],
      "width": 4032,
      "height": 3024,
      "creationTime": 1710937200
    },
    ...
  ]
}
```

### GET_THUMBNAIL 请求

```json
{
  "messageId": 2,
  "assetId": "F4C8B9A1-2C3D-4E5F-ABCD-1234567890",
  "size": 320
}
```

### GET_THUMBNAIL 响应

```
[消息头][JSON: {"messageId": 2}][JPEG 二进制数据]
```

### GET_IMAGE 请求

```json
{
  "messageId": 3,
  "assetId": "F4C8B9A1-2C3D-4E5F-ABCD-1234567890",
  "quality": "full",
  "format": "jpeg"
}
```

### GET_IMAGE 响应（流式）

```
[消息头: STREAM_CHUNK][JSON: {"messageId": 3, "chunk": 0}][JPEG 数据块]
[消息头: STREAM_CHUNK][JSON: {"messageId": 3, "chunk": 1}][JPEG 数据块]
...
[消息头: STREAM_END][JSON: {"messageId": 3}]
```

### GET_VIDEO_STREAM 请求

```json
{
  "messageId": 4,
  "assetId": "F4C8B9A1-2C3D-4E5F-ABCD-1234567890"
}
```

### GET_VIDEO_STREAM 响应（流式）

```
[消息头: STREAM_CHUNK][JSON: {"messageId": 4, "chunk": 0}][MP4 数据块]
[消息头: STREAM_CHUNK][JSON: {"messageId": 4, "chunk": 1}][MP4 数据块]
...
[消息头: STREAM_END][JSON: {"messageId": 4}]
```

## 实现状态

- ✅ 消息序列化/反序列化
- ✅ Bridge Service 框架
- ✅ 消息类型定义
- ⏳ usbmuxd 客户端实现
- ⏳ lockdownd 协议实现
- ⏳ iOS Companion Service 实现

## 下一步

1. 实现 usbmuxd 客户端的基础功能
2. 实现 lockdownd 协议
3. 实现 iOS Companion Service（Swift/Objective-C）
