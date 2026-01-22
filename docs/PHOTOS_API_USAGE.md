# Photos API 使用指南

## ✅ 集成成功确认

通过 `ios forward 8100 8100` 端口转发后，接口已可正常访问！

## 📋 API 端点列表

### 1. 健康检查
```bash
curl "http://localhost:8100/photos/health"
```

**响应示例：**
```json
{
  "value": {
    "status": "ok",
    "photoLibraryAuthorization": "authorized"
  }
}
```

### 2. 获取照片列表
```bash
curl "http://localhost:8100/photos/assets?limit=10&offset=0"
```

**参数：**
- `limit` (可选): 返回数量，默认 200
- `offset` (可选): 偏移量，默认 0

**响应示例：**
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
      },
      {
        "assetId": "A1B2C3D4-5E6F-7G8H-9I0J-K1L2M3N4O5P6",
        "type": "video",
        "width": 1920,
        "height": 1080,
        "duration": 30.5,
        "creationTime": 1710937300
      }
    ]
  }
}
```

### 3. 获取缩略图
```bash
# 使用默认尺寸 320
curl "http://localhost:8100/photos/asset/{assetId}/thumbnail" -o thumbnail.jpg

# 指定尺寸
curl "http://localhost:8100/photos/asset/{assetId}/thumbnail?size=640" -o thumbnail.jpg
```

**参数：**
- `assetId` (路径参数): 资源 ID（从列表接口获取）
- `size` (查询参数，可选): 缩略图尺寸，默认 320

**响应：**
- 成功：返回 JSON，包含 base64 编码的 JPEG 数据
- 失败：返回错误信息

**响应示例：**
```json
{
  "value": {
    "data": "base64_encoded_jpeg_data...",
    "format": "jpeg",
    "size": 24567
  }
}
```

**使用示例（保存缩略图）：**
```bash
# 获取 base64 数据并解码保存
curl -s "http://localhost:8100/photos/asset/{assetId}/thumbnail?size=320" | \
  python3 -c "import sys, json, base64; data=json.load(sys.stdin)['value']['data']; open('thumb.jpg','wb').write(base64.b64decode(data))"
```

### 4. 获取原图
```bash
# 获取原图（默认 full quality, jpeg format）
curl "http://localhost:8100/photos/asset/{assetId}/image" -o image.jpg

# 指定质量和格式
curl "http://localhost:8100/photos/asset/{assetId}/image?quality=screen&format=jpeg" -o image.jpg
```

**参数：**
- `assetId` (路径参数): 资源 ID
- `quality` (查询参数，可选): "full" 或 "screen"，默认 "full"
- `format` (查询参数，可选): "jpeg" 或 "heic"，默认 "jpeg"

**响应示例：**
```json
{
  "value": {
    "data": "base64_encoded_image_data...",
    "format": "jpeg",
    "size": 2456789
  }
}
```

**使用示例（保存原图）：**
```bash
curl -s "http://localhost:8100/photos/asset/{assetId}/image?quality=full&format=jpeg" | \
  python3 -c "import sys, json, base64; data=json.load(sys.stdin)['value']['data']; open('image.jpg','wb').write(base64.b64decode(data))"
```

### 5. 获取视频流
```bash
curl "http://localhost:8100/photos/asset/{assetId}/video/stream" -o video.mp4
```

**参数：**
- `assetId` (路径参数): 资源 ID（必须是视频类型）

**响应示例：**
```json
{
  "value": {
    "data": "base64_encoded_video_data...",
    "format": "mp4",
    "size": 12345678
  }
}
```

**使用示例（保存视频）：**
```bash
curl -s "http://localhost:8100/photos/asset/{assetId}/video/stream" | \
  python3 -c "import sys, json, base64; data=json.load(sys.stdin)['value']['data']; open('video.mp4','wb').write(base64.b64decode(data))"
```

## 🚀 实用脚本

### 脚本 1: 获取并保存所有照片的缩略图

```bash
#!/bin/bash
# save-all-thumbnails.sh

API_BASE="http://localhost:8100"
OUTPUT_DIR="./thumbnails"
LIMIT=200

mkdir -p "$OUTPUT_DIR"

# 获取照片列表
echo "获取照片列表..."
ASSETS=$(curl -s "${API_BASE}/photos/assets?limit=${LIMIT}&offset=0")

# 提取 assetId 列表
ASSET_IDS=$(echo "$ASSETS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data['value']['items']:
    print(item['assetId'])
")

# 下载每个缩略图
COUNT=0
for ASSET_ID in $ASSET_IDS; do
    COUNT=$((COUNT + 1))
    echo "[$COUNT] 下载缩略图: $ASSET_ID"
    
    curl -s "${API_BASE}/photos/asset/${ASSET_ID}/thumbnail?size=320" | \
      python3 -c "
import sys, json, base64
try:
    data = json.load(sys.stdin)['value']['data']
    with open('${OUTPUT_DIR}/${ASSET_ID}.jpg', 'wb') as f:
        f.write(base64.b64decode(data))
    print('  ✅ 保存成功')
except Exception as e:
    print(f'  ❌ 错误: {e}')
" 2>/dev/null
    
    sleep 0.1  # 避免请求过快
done

echo "完成！缩略图保存在 $OUTPUT_DIR/"
```

### 脚本 2: 批量下载照片

```bash
#!/bin/bash
# download-photos.sh

API_BASE="http://localhost:8100"
OUTPUT_DIR="./photos"
LIMIT=50
QUALITY="full"  # full 或 screen

mkdir -p "$OUTPUT_DIR"

# 获取照片列表（只获取图片，不包括视频）
echo "获取照片列表..."
ASSETS=$(curl -s "${API_BASE}/photos/assets?limit=${LIMIT}&offset=0")

# 提取图片 assetId
IMAGE_IDS=$(echo "$ASSETS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data['value']['items']:
    if item['type'] == 'image':
        print(item['assetId'])
")

# 下载每张图片
COUNT=0
for ASSET_ID in $IMAGE_IDS; do
    COUNT=$((COUNT + 1))
    echo "[$COUNT] 下载图片: $ASSET_ID"
    
    curl -s "${API_BASE}/photos/asset/${ASSET_ID}/image?quality=${QUALITY}&format=jpeg" | \
      python3 -c "
import sys, json, base64
try:
    data = json.load(sys.stdin)['value']['data']
    with open('${OUTPUT_DIR}/${ASSET_ID}.jpg', 'wb') as f:
        f.write(base64.b64decode(data))
    print('  ✅ 保存成功')
except Exception as e:
    print(f'  ❌ 错误: {e}')
" 2>/dev/null
    
    sleep 0.2  # 避免请求过快
done

echo "完成！图片保存在 $OUTPUT_DIR/"
```

### 脚本 3: 快速测试所有接口

```bash
#!/bin/bash
# test-all-apis.sh

API_BASE="http://localhost:8100"

echo "=== Photos API 测试 ==="
echo ""

# 1. 健康检查
echo "1. 健康检查..."
curl -s "${API_BASE}/photos/health" | python3 -m json.tool
echo ""

# 2. 获取照片列表
echo "2. 获取照片列表（前 5 张）..."
ASSETS=$(curl -s "${API_BASE}/photos/assets?limit=5&offset=0")
echo "$ASSETS" | python3 -m json.tool
echo ""

# 3. 获取第一张照片的 assetId
FIRST_ASSET_ID=$(echo "$ASSETS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data['value']['items']:
    print(data['value']['items'][0]['assetId'])
")

if [ -n "$FIRST_ASSET_ID" ]; then
    echo "3. 获取缩略图 (assetId: $FIRST_ASSET_ID)..."
    THUMB=$(curl -s "${API_BASE}/photos/asset/${FIRST_ASSET_ID}/thumbnail?size=320")
    THUMB_SIZE=$(echo "$THUMB" | python3 -c "import sys, json; print(json.load(sys.stdin)['value']['size'])")
    echo "   ✅ 缩略图大小: ${THUMB_SIZE} bytes"
    echo ""
    
    # 检查是否是图片
    ASSET_TYPE=$(echo "$ASSETS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data['value']['items']:
    print(data['value']['items'][0]['type'])
")
    
    if [ "$ASSET_TYPE" = "image" ]; then
        echo "4. 获取原图 (assetId: $FIRST_ASSET_ID)..."
        IMAGE=$(curl -s "${API_BASE}/photos/asset/${FIRST_ASSET_ID}/image?quality=screen&format=jpeg")
        IMAGE_SIZE=$(echo "$IMAGE" | python3 -c "import sys, json; print(json.load(sys.stdin)['value']['size'])")
        echo "   ✅ 图片大小: ${IMAGE_SIZE} bytes"
    fi
fi

echo ""
echo "=== 测试完成 ==="
```

## 📝 Python 使用示例

```python
#!/usr/bin/env python3
# photos_api_client.py

import requests
import json
import base64
import sys

API_BASE = "http://localhost:8100"

def get_health():
    """健康检查"""
    response = requests.get(f"{API_BASE}/photos/health")
    return response.json()

def get_assets(limit=200, offset=0):
    """获取照片列表"""
    response = requests.get(
        f"{API_BASE}/photos/assets",
        params={"limit": limit, "offset": offset}
    )
    return response.json()

def get_thumbnail(asset_id, size=320):
    """获取缩略图"""
    response = requests.get(
        f"{API_BASE}/photos/asset/{asset_id}/thumbnail",
        params={"size": size}
    )
    data = response.json()
    if "value" in data and "data" in data["value"]:
        return base64.b64decode(data["value"]["data"])
    return None

def get_image(asset_id, quality="full", format="jpeg"):
    """获取原图"""
    response = requests.get(
        f"{API_BASE}/photos/asset/{asset_id}/image",
        params={"quality": quality, "format": format}
    )
    data = response.json()
    if "value" in data and "data" in data["value"]:
        return base64.b64decode(data["value"]["data"])
    return None

def get_video(asset_id):
    """获取视频"""
    response = requests.get(
        f"{API_BASE}/photos/asset/{asset_id}/video/stream"
    )
    data = response.json()
    if "value" in data and "data" in data["value"]:
        return base64.b64decode(data["value"]["data"])
    return None

# 使用示例
if __name__ == "__main__":
    # 健康检查
    print("健康检查:", get_health())
    
    # 获取照片列表
    assets = get_assets(limit=10)
    print(f"\n照片总数: {assets['value']['total']}")
    print(f"返回数量: {len(assets['value']['items'])}")
    
    # 下载第一张照片的缩略图
    if assets['value']['items']:
        first_asset = assets['value']['items'][0]
        asset_id = first_asset['assetId']
        print(f"\n下载缩略图: {asset_id}")
        
        thumbnail = get_thumbnail(asset_id)
        if thumbnail:
            with open(f"{asset_id}_thumb.jpg", "wb") as f:
                f.write(thumbnail)
            print(f"✅ 缩略图已保存: {len(thumbnail)} bytes")
        
        # 如果是图片，下载原图
        if first_asset['type'] == 'image':
            print(f"\n下载原图: {asset_id}")
            image = get_image(asset_id, quality="screen")
            if image:
                with open(f"{asset_id}_image.jpg", "wb") as f:
                    f.write(image)
                print(f"✅ 原图已保存: {len(image)} bytes")
```

## 🔧 注意事项

### 1. 端口转发
确保端口转发正在运行：
```bash
# 启动端口转发
ios forward 8100 8100

# 或使用 iproxy
iproxy 8100 8100 &
```

### 2. 权限
首次访问照片库时，需要在设备上授权：
- 设置 > 隐私 > 照片 > WebDriverAgentRunner > 允许访问所有照片

### 3. 性能
- 缩略图：通常 < 30KB，响应快
- 原图：可能很大（几 MB），需要时间
- 视频：可能非常大，建议使用流式传输（当前版本返回完整文件）

### 4. Base64 编码
当前实现使用 base64 编码返回二进制数据，会增加约 33% 的数据量。后续可以优化为直接返回二进制数据。

## 🎯 快速测试命令

```bash
# 1. 健康检查
curl "http://localhost:8100/photos/health" | python3 -m json.tool

# 2. 获取前 10 张照片
curl "http://localhost:8100/photos/assets?limit=10&offset=0" | python3 -m json.tool

# 3. 获取第一张照片的 assetId 并下载缩略图
ASSET_ID=$(curl -s "http://localhost:8100/photos/assets?limit=1" | python3 -c "import sys, json; print(json.load(sys.stdin)['value']['items'][0]['assetId'])")
curl -s "http://localhost:8100/photos/asset/${ASSET_ID}/thumbnail?size=320" | python3 -c "import sys, json, base64; data=json.load(sys.stdin)['value']['data']; open('thumb.jpg','wb').write(base64.b64decode(data))"
echo "缩略图已保存为 thumb.jpg"
```

## ✅ 集成完成确认

- ✅ WebDriverAgent 运行正常
- ✅ 端口转发配置正确
- ✅ Photos API 接口可访问
- ✅ 所有端点正常工作

现在可以开始使用 Photos API 了！🎉
