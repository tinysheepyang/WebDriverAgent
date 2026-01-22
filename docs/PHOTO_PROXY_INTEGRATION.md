# Photo-Proxy 集成到 WebDriverAgentRunner 方案

## 项目分析

### Photo-Proxy 项目结构
- **PC 端（Node.js）**：HTTP 服务器（端口 9001），通过 usbmuxd 与 iOS 通信
- **iOS 端（PhotoCompanion）**：SwiftUI 应用，监听 TCP 12345，使用二进制协议

### WebDriverAgentRunner 现状
- UI 测试 bundle（.xctest）
- 已有 HTTP 服务器（RoutingHTTPServer）
- 使用 FBCommandHandler 协议注册路由
- 默认端口：8100（可通过 USE_PORT 环境变量配置）

## 集成方案对比

### 方案一：HTTP 路由集成（推荐）✅

**优点：**
- ✅ 复用现有 HTTP 服务器，无需额外端口
- ✅ 遵循 WebDriverAgent 架构，易于维护
- ✅ 与现有 WebDriver 命令统一管理
- ✅ 实现简单，只需添加 CommandHandler

**缺点：**
- ⚠️ 需要将二进制协议改为 HTTP REST API
- ⚠️ 需要适配现有的路由系统

**实现步骤：**

1. **创建 Photos Command Handler**
   ```objective-c
   // WebDriverAgentLib/Commands/FBPhotosCommands.h
   #import <WebDriverAgentLib/FBCommandHandler.h>
   
   @interface FBPhotosCommands : NSObject <FBCommandHandler>
   @end
   ```

2. **实现路由**
   ```objective-c
   // WebDriverAgentLib/Commands/FBPhotosCommands.m
   + (NSArray *)routes {
     return @[
       [[FBRoute GET:@"/photos/assets"].withoutSession 
         respondWithTarget:self action:@selector(handleGetAssets:)],
       [[FBRoute GET:@"/photos/asset/:assetId/thumbnail"].withoutSession 
         respondWithTarget:self action:@selector(handleGetThumbnail:)],
       [[FBRoute GET:@"/photos/asset/:assetId/image"].withoutSession 
         respondWithTarget:self action:@selector(handleGetImage:)],
       [[FBRoute GET:@"/photos/asset/:assetId/video/stream"].withoutSession 
         respondWithTarget:self action:@selector(handleGetVideoStream:)],
     ];
   }
   ```

3. **使用 Photos 框架**
   ```objective-c
   #import <Photos/Photos.h>
   
   - (id<FBResponsePayload>)handleGetAssets:(FBRouteRequest *)request {
     PHFetchOptions *options = [[PHFetchOptions alloc] init];
     options.sortDescriptors = @[[NSSortDescriptor sortDescriptorWithKey:@"creationDate" ascending:NO]];
     PHFetchResult *assets = [PHAsset fetchAssetsWithOptions:options];
     
     // 转换为 JSON 响应
     NSMutableArray *items = [NSMutableArray array];
     [assets enumerateObjectsUsingBlock:^(PHAsset *asset, NSUInteger idx, BOOL *stop) {
       [items addObject:@{
         @"assetId": asset.localIdentifier,
         @"type": asset.mediaType == PHAssetMediaTypeImage ? @"image" : @"video",
         @"width": @(asset.pixelWidth),
         @"height": @(asset.pixelHeight)
       }];
     }];
     
     return FBResponseWithObject(@{@"total": @(assets.count), @"items": items});
   }
   ```

4. **添加 Info.plist 权限**
   ```xml
   <key>NSPhotoLibraryUsageDescription</key>
   <string>WebDriverAgent needs access to photos for automation testing</string>
   <key>NSPhotoLibraryAddUsageDescription</key>
   <string>WebDriverAgent needs access to save photos</string>
   ```

### 方案二：独立 TCP 服务器（类似 PhotoCompanion）

**优点：**
- ✅ 保持二进制协议，性能更好
- ✅ 可以完全复用 PhotoCompanion 代码
- ✅ 独立服务，不影响现有功能

**缺点：**
- ⚠️ 需要额外端口（12345）
- ⚠️ 需要处理端口冲突
- ⚠️ 增加系统复杂度

**实现步骤：**

1. **将 PhotoCompanion 代码移植到 WebDriverAgentLib**
   - 复制 `ServiceBinary.swift` 到 `WebDriverAgentLib/Photos/`
   - 转换为 Objective-C（或使用 Swift 桥接）

2. **在 WebDriverAgentRunner 启动时初始化**
   ```objective-c
   // UITestingUITests.m
   - (void)testRunner {
     FBWebServer *webServer = [[FBWebServer alloc] init];
     webServer.delegate = self;
     
     // 启动照片服务
     PhotoCompanionService *photoService = [[PhotoCompanionService alloc] init];
     [photoService start];
     
     [webServer startServing];
   }
   ```

3. **处理端口冲突**
   - 检查端口 12345 是否被占用
   - 如果被占用，使用备用端口或报错

## 推荐方案：方案一（HTTP 路由集成）

### 理由
1. **架构一致性**：与 WebDriverAgent 现有架构完全一致
2. **维护性**：遵循现有代码规范，易于维护
3. **简单性**：无需处理端口冲突，无需额外服务
4. **兼容性**：不影响现有功能，向后兼容

### 实施计划

#### Phase 1: 基础框架
1. 创建 `FBPhotosCommands` 类
2. 添加 Photos 框架依赖
3. 添加 Info.plist 权限
4. 实现基础路由注册

#### Phase 2: 核心功能
1. 实现 `GET /photos/assets` - 获取资源列表
2. 实现 `GET /photos/asset/:assetId/thumbnail` - 获取缩略图
3. 实现缓存机制（内存缓存）

#### Phase 3: 高级功能
1. 实现 `GET /photos/asset/:assetId/image` - 获取原图（流式）
2. 实现 `GET /photos/asset/:assetId/video/stream` - 获取视频流
3. 实现 HEIC 转 JPEG 转换

#### Phase 4: 优化
1. 添加磁盘缓存
2. 实现预取机制
3. 性能优化

### 代码示例

#### 1. 创建 FBPhotosCommands.h
```objective-c
#import <WebDriverAgentLib/FBCommandHandler.h>

NS_ASSUME_NONNULL_BEGIN

@interface FBPhotosCommands : NSObject <FBCommandHandler>
@end

NS_ASSUME_NONNULL_END
```

#### 2. 创建 FBPhotosCommands.m（基础版本）
```objective-c
#import "FBPhotosCommands.h"
#import <WebDriverAgentLib/FBRouteRequest.h>
#import <WebDriverAgentLib/FBResponsePayload.h>
#import <Photos/Photos.h>

@implementation FBPhotosCommands

+ (NSArray *)routes {
  return @[
    [[FBRoute GET:@"/photos/assets"].withoutSession 
      respondWithTarget:self action:@selector(handleGetAssets:)],
    [[FBRoute GET:@"/photos/asset/:assetId/thumbnail"].withoutSession 
      respondWithTarget:self action:@selector(handleGetThumbnail:)],
  ];
}

- (id<FBResponsePayload>)handleGetAssets:(FBRouteRequest *)request {
  NSInteger limit = [request.parameters[@"limit"] integerValue] ?: 200;
  NSInteger offset = [request.parameters[@"offset"] integerValue] ?: 0;
  
  PHFetchOptions *options = [[PHFetchOptions alloc] init];
  options.sortDescriptors = @[[NSSortDescriptor sortDescriptorWithKey:@"creationDate" ascending:NO]];
  PHFetchResult *assets = [PHAsset fetchAssetsWithOptions:options];
  
  NSMutableArray *items = [NSMutableArray array];
  NSInteger endIndex = MIN(offset + limit, assets.count);
  
  for (NSInteger i = offset; i < endIndex; i++) {
    PHAsset *asset = assets[i];
    [items addObject:@{
      @"assetId": asset.localIdentifier,
      @"type": asset.mediaType == PHAssetMediaTypeImage ? @"image" : @"video",
      @"width": @(asset.pixelWidth),
      @"height": @(asset.pixelHeight),
      @"creationTime": @([asset.creationDate timeIntervalSince1970])
    }];
  }
  
  return FBResponseWithObject(@{
    @"total": @(assets.count),
    @"items": items
  });
}

- (id<FBResponsePayload>)handleGetThumbnail:(FBRouteRequest *)request {
  NSString *assetId = request.parameters[@"assetId"];
  NSInteger size = [request.parameters[@"size"] integerValue] ?: 320;
  
  PHFetchResult *result = [PHAsset fetchAssetsWithLocalIdentifiers:@[assetId] options:nil];
  if (result.count == 0) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Asset not found" traceback:nil]);
  }
  
  PHAsset *asset = result.firstObject;
  PHImageRequestOptions *options = [[PHImageRequestOptions alloc] init];
  options.deliveryMode = PHImageRequestOptionsDeliveryModeFastFormat;
  options.resizeMode = PHImageRequestOptionsResizeModeFast;
  options.synchronous = YES;
  
  __block UIImage *thumbnail = nil;
  [[PHImageManager defaultManager] requestImageForAsset:asset
                                               targetSize:CGSizeMake(size, size)
                                              contentMode:PHImageContentModeAspectFill
                                                  options:options
                                            resultHandler:^(UIImage *result, NSDictionary *info) {
    thumbnail = result;
  }];
  
  if (!thumbnail) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Failed to generate thumbnail" traceback:nil]);
  }
  
  NSData *jpegData = UIImageJPEGRepresentation(thumbnail, 0.7);
  // 返回二进制数据需要特殊处理
  // 这里简化处理，实际需要返回正确的 HTTP 响应
  return FBResponseWithObject(@{@"data": [jpegData base64EncodedStringWithOptions:0]});
}

@end
```

#### 3. 修改 Info.plist
```xml
<key>NSPhotoLibraryUsageDescription</key>
<string>WebDriverAgent needs access to photos for automation testing</string>
```

#### 4. 修改 project.pbxproj
- 添加 Photos.framework 依赖
- 确保 FBPhotosCommands 被编译

## 注意事项

### 1. 权限问题
- iOS 需要用户授权访问照片库
- 首次访问会弹出权限请求
- 测试时需要在设置中手动授权

### 2. 性能考虑
- 大量照片查询可能较慢
- 建议实现分页和缓存
- 缩略图生成需要时间

### 3. 内存管理
- Photos 框架会缓存图片
- 注意内存使用，避免 OOM
- 实现适当的缓存清理机制

### 4. 线程安全
- PHImageManager 是线程安全的
- 但建议在主线程或后台队列中操作

### 5. 错误处理
- 处理权限被拒绝的情况
- 处理照片库为空的情况
- 处理资源不存在的情况

## 测试建议

1. **单元测试**
   - 测试路由注册
   - 测试权限检查
   - 测试数据转换

2. **集成测试**
   - 测试完整流程
   - 测试错误处理
   - 测试性能

3. **真机测试**
   - 测试权限流程
   - 测试大量照片场景
   - 测试视频流传输

## 总结

**推荐使用方案一（HTTP 路由集成）**，因为：
- 架构一致，易于维护
- 实现简单，开发成本低
- 无需额外端口，减少冲突
- 与现有功能完美集成

实施时建议分阶段进行，先实现基础功能，再逐步完善高级特性。
