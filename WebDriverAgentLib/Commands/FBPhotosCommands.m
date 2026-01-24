/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBPhotosCommands.h"

#import <Photos/Photos.h>
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import "FBCommandStatus.h"
#import "FBLogger.h"
#import "FBProtocolHelpers.h"
#import "FBRouteRequest.h"
#import "FBResponsePayload.h"
#import "RouteResponse.h"

@implementation FBPhotosCommands

#pragma mark - <FBCommandHandler>

+ (NSArray *)routes
{
  return
  @[
    // GET /photos/assets?limit=200&offset=0
    [[FBRoute GET:@"/photos/assets"].withoutSession respondWithTarget:self action:@selector(handleGetAssets:)],
    
    // GET /photos/asset/:assetId/thumbnail?size=320
    [[FBRoute GET:@"/photos/asset/:assetId/thumbnail"].withoutSession respondWithTarget:self action:@selector(handleGetThumbnail:)],
    
    // GET /photos/asset/:assetId/image?quality=full&format=jpeg
    [[FBRoute GET:@"/photos/asset/:assetId/image"].withoutSession respondWithTarget:self action:@selector(handleGetImage:)],
    
    // GET /photos/asset/:assetId/video/stream
    [[FBRoute GET:@"/photos/asset/:assetId/video/stream"].withoutSession respondWithTarget:self action:@selector(handleGetVideoStream:)],
    
    // GET /photos/health
    [[FBRoute GET:@"/photos/health"].withoutSession respondWithTarget:self action:@selector(handleHealth:)],
    
    // POST /photos/http-request - 通过设备端发起 HTTP 请求
    [[FBRoute POST:@"/photos/http-request"].withoutSession respondWithTarget:self action:@selector(handleHttpRequest:)],
    
    // GET /photos/network-diagnosis - 网络诊断
    [[FBRoute GET:@"/photos/network-diagnosis"].withoutSession respondWithTarget:self action:@selector(handleNetworkDiagnosis:)],
  ];
}

#pragma mark - Commands

/**
 * GET /photos/assets?limit=200&offset=0
 * Returns list of photo assets
 */
+ (id<FBResponsePayload>)handleGetAssets:(FBRouteRequest *)request
{
  // Check photo library authorization
  PHAuthorizationStatus authStatus = [PHPhotoLibrary authorizationStatus];
  if (authStatus == PHAuthorizationStatusDenied || authStatus == PHAuthorizationStatusRestricted) {
    NSString *errorMsg = @"Photo library access denied. Please grant permission in Settings > Privacy > Photos";
    [FBLogger log:errorMsg];
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:errorMsg traceback:nil]);
  }
  
  // Request authorization if not determined
  if (authStatus == PHAuthorizationStatusNotDetermined) {
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block PHAuthorizationStatus status = PHAuthorizationStatusNotDetermined;
    
    [PHPhotoLibrary requestAuthorization:^(PHAuthorizationStatus authorizationStatus) {
      status = authorizationStatus;
      dispatch_semaphore_signal(semaphore);
    }];
    
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
    
    if (status != PHAuthorizationStatusAuthorized && status != PHAuthorizationStatusLimited) {
      NSString *errorMsg = @"Photo library access not authorized";
      [FBLogger log:errorMsg];
      return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:errorMsg traceback:nil]);
    }
  }
  
  // Parse parameters (query parameters are in request.parameters, body parameters are in request.arguments)
  NSInteger limit = 200;
  NSInteger offset = 0;
  
  if (request.parameters[@"limit"]) {
    limit = [request.parameters[@"limit"] integerValue];
  }
  
  if (request.parameters[@"offset"]) {
    offset = [request.parameters[@"offset"] integerValue];
  }
  
  [FBLogger logFmt:@"Getting assets: limit=%ld, offset=%ld", (long)limit, (long)offset];
  
  // Fetch assets
  PHFetchOptions *options = [[PHFetchOptions alloc] init];
  options.sortDescriptors = @[[NSSortDescriptor sortDescriptorWithKey:@"creationDate" ascending:NO]];
  PHFetchResult *assets = [PHAsset fetchAssetsWithOptions:options];
  
  NSMutableArray *items = [NSMutableArray array];
  NSInteger total = assets.count;
  NSInteger endIndex = MIN(offset + limit, total);
  
  for (NSInteger i = offset; i < endIndex; i++) {
    PHAsset *asset = assets[i];
    NSMutableDictionary *item = [NSMutableDictionary dictionaryWithDictionary:@{
      @"assetId": asset.localIdentifier,
      @"type": asset.mediaType == PHAssetMediaTypeImage ? @"image" : @"video",
      @"width": @(asset.pixelWidth),
      @"height": @(asset.pixelHeight),
    }];
    
    if (asset.creationDate) {
      item[@"creationTime"] = @([asset.creationDate timeIntervalSince1970]);
    }
    
    if (asset.mediaType == PHAssetMediaTypeVideo) {
      item[@"duration"] = @(asset.duration);
    }
    
    [items addObject:item];
  }
  
  [FBLogger logFmt:@"Returning %ld items (total: %ld)", (long)items.count, (long)total];
  
  return FBResponseWithObject(@{
    @"total": @(total),
    @"items": items
  });
}

/**
 * GET /photos/asset/:assetId/thumbnail?size=320
 * Returns thumbnail image as JPEG
 */
+ (id<FBResponsePayload>)handleGetThumbnail:(FBRouteRequest *)request
{
  NSString *assetId = request.parameters[@"assetId"];
  if (!assetId || assetId.length == 0) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Missing assetId parameter" traceback:nil]);
  }
  
  NSInteger size = 320;
  if (request.parameters[@"size"]) {
    size = [request.parameters[@"size"] integerValue];
  }
  
  [FBLogger logFmt:@"Getting thumbnail for assetId=%@, size=%ld", assetId, (long)size];
  
  // Fetch asset
  PHFetchResult *result = [PHAsset fetchAssetsWithLocalIdentifiers:@[assetId] options:nil];
  if (result.count == 0) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Asset not found" traceback:nil]);
  }
  
  PHAsset *asset = result.firstObject;
  
  // Request thumbnail
  PHImageRequestOptions *options = [[PHImageRequestOptions alloc] init];
  options.deliveryMode = PHImageRequestOptionsDeliveryModeFastFormat;
  options.resizeMode = PHImageRequestOptionsResizeModeFast;
  options.synchronous = YES;
  options.networkAccessAllowed = YES;
  
  CGSize targetSize = CGSizeMake(size, size);
  __block UIImage *thumbnail = nil;
  __block NSError *requestError = nil;
  
  [[PHImageManager defaultManager] requestImageForAsset:asset
                                             targetSize:targetSize
                                            contentMode:PHImageContentModeAspectFill
                                                options:options
                                          resultHandler:^(UIImage *imageResult, NSDictionary *info) {
    thumbnail = imageResult;
    requestError = info[PHImageErrorKey];
  }];
  
  if (requestError) {
    [FBLogger logFmt:@"Error getting thumbnail: %@", requestError.localizedDescription];
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:requestError.localizedDescription traceback:nil]);
  }
  
  if (!thumbnail) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Failed to generate thumbnail" traceback:nil]);
  }
  
  // Convert to JPEG
  NSData *jpegData = UIImageJPEGRepresentation(thumbnail, 0.7);
  
  // Ensure size is <= 30KB
  if (jpegData.length > 30 * 1024) {
    jpegData = UIImageJPEGRepresentation(thumbnail, 0.5);
  }
  
  [FBLogger logFmt:@"Thumbnail generated: %ld bytes", (long)jpegData.length];
  
  // Return as base64 string (for compatibility with existing response system)
  // TODO: Optimize to return binary data directly
  NSString *base64String = [jpegData base64EncodedStringWithOptions:0];
  return FBResponseWithObject(@{
    @"data": base64String,
    @"format": @"jpeg",
    @"size": @(jpegData.length)
  });
}

/**
 * GET /photos/asset/:assetId/image?quality=full&format=jpeg
 * Returns full image
 */
+ (id<FBResponsePayload>)handleGetImage:(FBRouteRequest *)request
{
  NSString *assetId = request.parameters[@"assetId"];
  if (!assetId || assetId.length == 0) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Missing assetId parameter" traceback:nil]);
  }
  
  NSString *quality = request.parameters[@"quality"] ?: @"full";
  NSString *format = request.parameters[@"format"] ?: @"jpeg";
  
  [FBLogger logFmt:@"Getting image for assetId=%@, quality=%@, format=%@", assetId, quality, format];
  
  // Fetch asset
  PHFetchResult *result = [PHAsset fetchAssetsWithLocalIdentifiers:@[assetId] options:nil];
  if (result.count == 0) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Asset not found" traceback:nil]);
  }
  
  PHAsset *asset = result.firstObject;
  
  if (asset.mediaType != PHAssetMediaTypeImage) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Asset is not an image" traceback:nil]);
  }
  
  // Request image data
  PHImageRequestOptions *options = [[PHImageRequestOptions alloc] init];
  options.deliveryMode = [quality isEqualToString:@"full"] ? PHImageRequestOptionsDeliveryModeHighQualityFormat : PHImageRequestOptionsDeliveryModeFastFormat;
  options.synchronous = YES;
  options.networkAccessAllowed = YES;
  
  __block NSData *imageData = nil;
  __block NSString *uti = nil;
  __block NSError *requestError = nil;
  
  [[PHImageManager defaultManager] requestImageDataAndOrientationForAsset:asset
                                                                    options:options
                                                              resultHandler:^(NSData *data, NSString *dataUTI, CGImagePropertyOrientation orientation, NSDictionary *info) {
    imageData = data;
    uti = dataUTI;
    requestError = info[PHImageErrorKey];
  }];
  
  if (requestError) {
    [FBLogger logFmt:@"Error getting image: %@", requestError.localizedDescription];
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:requestError.localizedDescription traceback:nil]);
  }
  
  if (!imageData) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Failed to get image data" traceback:nil]);
  }
  
  // Convert HEIC to JPEG if needed
  NSData *finalData = imageData;
  if (uti && ([uti containsString:@"heic"] || [uti containsString:@"heif"])) {
    UIImage *image = [UIImage imageWithData:imageData];
    if (image) {
      CGFloat compressionQuality = [quality isEqualToString:@"full"] ? 0.9 : 0.7;
      NSData *jpegData = UIImageJPEGRepresentation(image, compressionQuality);
      if (jpegData) {
        finalData = jpegData;
        [FBLogger logFmt:@"HEIC converted to JPEG: %ld -> %ld bytes", (long)imageData.length, (long)jpegData.length];
      }
    }
  }
  
  [FBLogger logFmt:@"Image retrieved: %ld bytes", (long)finalData.length];
  
  // Return as base64 string
  NSString *base64String = [finalData base64EncodedStringWithOptions:0];
  return FBResponseWithObject(@{
    @"data": base64String,
    @"format": format,
    @"size": @(finalData.length)
  });
}

/**
 * GET /photos/asset/:assetId/video/stream
 * Returns video stream (simplified - returns base64 for now)
 */
+ (id<FBResponsePayload>)handleGetVideoStream:(FBRouteRequest *)request
{
  NSString *assetId = request.parameters[@"assetId"];
  if (!assetId || assetId.length == 0) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Missing assetId parameter" traceback:nil]);
  }
  
  [FBLogger logFmt:@"Getting video stream for assetId=%@", assetId];
  
  // Fetch asset
  PHFetchResult *result = [PHAsset fetchAssetsWithLocalIdentifiers:@[assetId] options:nil];
  if (result.count == 0) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Asset not found" traceback:nil]);
  }
  
  PHAsset *asset = result.firstObject;
  
  if (asset.mediaType != PHAssetMediaTypeVideo) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Asset is not a video" traceback:nil]);
  }
  
  // Request video asset
  PHVideoRequestOptions *options = [[PHVideoRequestOptions alloc] init];
  options.deliveryMode = PHVideoRequestOptionsDeliveryModeHighQualityFormat;
  options.networkAccessAllowed = YES;
  
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block AVAsset *avAsset = nil;
  __block NSError *requestError = nil;
  
  [[PHImageManager defaultManager] requestAVAssetForVideo:asset
                                                   options:options
                                             resultHandler:^(AVAsset *videoAsset, AVAudioMix *audioMix, NSDictionary *info) {
    avAsset = videoAsset;
    requestError = info[PHImageErrorKey];
    dispatch_semaphore_signal(semaphore);
  }];
  
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  
  if (requestError) {
    [FBLogger logFmt:@"Error getting video: %@", requestError.localizedDescription];
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:requestError.localizedDescription traceback:nil]);
  }
  
  if (!avAsset || ![avAsset isKindOfClass:[AVURLAsset class]]) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Failed to get video asset" traceback:nil]);
  }
  
  AVURLAsset *urlAsset = (AVURLAsset *)avAsset;
  NSURL *videoURL = urlAsset.URL;
  
  if (!videoURL.isFileURL) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Video URL is not a file URL" traceback:nil]);
  }
  
  // Read video file
  NSError *readError = nil;
  NSData *videoData = [NSData dataWithContentsOfURL:videoURL options:NSDataReadingMappedIfSafe error:&readError];
  
  if (readError || !videoData) {
    [FBLogger logFmt:@"Error reading video file: %@", readError.localizedDescription];
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:readError.localizedDescription traceback:nil]);
  }
  
  [FBLogger logFmt:@"Video retrieved: %ld bytes", (long)videoData.length];
  
  // Return as base64 string (for now - streaming can be optimized later)
  NSString *base64String = [videoData base64EncodedStringWithOptions:0];
  return FBResponseWithObject(@{
    @"data": base64String,
    @"format": @"mp4",
    @"size": @(videoData.length)
  });
}

/**
 * GET /photos/health
 * Health check endpoint
 */
+ (id<FBResponsePayload>)handleHealth:(FBRouteRequest *)request
{
  PHAuthorizationStatus authStatus = [PHPhotoLibrary authorizationStatus];
  NSString *status = @"unknown";
  
  switch (authStatus) {
    case PHAuthorizationStatusNotDetermined:
      status = @"not_determined";
      break;
    case PHAuthorizationStatusRestricted:
      status = @"restricted";
      break;
    case PHAuthorizationStatusDenied:
      status = @"denied";
      break;
    case PHAuthorizationStatusAuthorized:
      status = @"authorized";
      break;
    case PHAuthorizationStatusLimited:
      status = @"limited";
      break;
    default:
      status = @"unknown";
      break;
  }
  
  return FBResponseWithObject(@{
    @"status": @"ok",
    @"photoLibraryAuthorization": status
  });
}

/**
 * POST /photos/http-request
 * 通过设备端发起 HTTP 请求（类似 PhotoCompanion 的 HTTP_REQUEST 功能）
 * 
 * 请求体：
 * {
 *   "url": "http://example.com/api",
 *   "method": "GET",
 *   "headers": {"Authorization": "Bearer token"},
 *   "body": "request body",
 *   "timeout": 15.0
 * }
 */
+ (id<FBResponsePayload>)handleHttpRequest:(FBRouteRequest *)request
{
  NSString *urlString = request.arguments[@"url"];
  if (!urlString || urlString.length == 0) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Missing url parameter" traceback:nil]);
  }
  
  NSString *method = [request.arguments[@"method"] uppercaseString] ?: @"GET";
  NSDictionary *headers = request.arguments[@"headers"] ?: @{};
  NSString *bodyString = request.arguments[@"body"];
  NSNumber *timeoutNumber = request.arguments[@"timeout"];
  NSTimeInterval timeout = timeoutNumber ? timeoutNumber.doubleValue : 15.0;
  
  [FBLogger logFmt:@"📤 HTTP_REQUEST via WebDriverAgent: %@ %@", method, urlString];
  
  NSURL *url = [NSURL URLWithString:urlString];
  if (!url) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:[NSString stringWithFormat:@"Invalid URL: %@", urlString] traceback:nil]);
  }
  
  NSMutableURLRequest *urlRequest = [NSMutableURLRequest requestWithURL:url];
  urlRequest.HTTPMethod = method;
  urlRequest.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  urlRequest.timeoutInterval = timeout;
  
  // 设置请求头
  for (NSString *key in headers) {
    [urlRequest setValue:headers[key] forHTTPHeaderField:key];
  }
  
  // 设置请求体
  if (bodyString) {
    urlRequest.HTTPBody = [bodyString dataUsingEncoding:NSUTF8StringEncoding];
  }
  
  // 创建 URLSession 配置（参考 photo-proxy 的实现）
  // 注意：测试 bundle 可能需要在主线程执行网络请求
  NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
  config.timeoutIntervalForRequest = timeout;
  config.timeoutIntervalForResource = timeout;
  config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  
  NSURLSession *session = [NSURLSession sessionWithConfiguration:config];
  
  // 使用信号量等待异步请求完成
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block NSInteger statusCode = 0;
  __block NSDictionary *responseHeaders = @{};
  __block NSString *responseBody = @"";
  __block NSError *requestError = nil;
  __block NSURLSessionDataTask *task = nil;
  
  // 确保在主线程执行（测试 bundle 可能需要）
  if ([NSThread isMainThread]) {
    task = [session dataTaskWithRequest:urlRequest completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
      if (error) {
        requestError = error;
        [FBLogger logFmt:@"❌ HTTP_REQUEST failed: %@", error.localizedDescription];
        dispatch_semaphore_signal(semaphore);
        return;
      }
      
      if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
        NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
        statusCode = httpResponse.statusCode;
        
        // 提取响应头
        NSMutableDictionary *headersDict = [NSMutableDictionary dictionary];
        for (NSString *key in httpResponse.allHeaderFields.allKeys) {
          headersDict[key] = [NSString stringWithFormat:@"%@", httpResponse.allHeaderFields[key]];
        }
        responseHeaders = headersDict;
      }
      
      // 提取响应体
      if (data) {
        responseBody = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (!responseBody) {
          // 如果不是 UTF-8 文本，返回 base64 编码
          responseBody = [data base64EncodedStringWithOptions:0];
        }
      }
      
      [FBLogger logFmt:@"✅ HTTP_REQUEST completed: status=%ld, bodySize=%ld", (long)statusCode, (long)(data ? data.length : 0)];
      dispatch_semaphore_signal(semaphore);
    }];
    [task resume];
  } else {
    dispatch_async(dispatch_get_main_queue(), ^{
      task = [session dataTaskWithRequest:urlRequest completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) {
          requestError = error;
          [FBLogger logFmt:@"❌ HTTP_REQUEST failed: %@", error.localizedDescription];
          dispatch_semaphore_signal(semaphore);
          return;
        }
        
        if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
          NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;
          statusCode = httpResponse.statusCode;
          
          // 提取响应头
          NSMutableDictionary *headersDict = [NSMutableDictionary dictionary];
          for (NSString *key in httpResponse.allHeaderFields.allKeys) {
            headersDict[key] = [NSString stringWithFormat:@"%@", httpResponse.allHeaderFields[key]];
          }
          responseHeaders = headersDict;
        }
        
        // 提取响应体
        if (data) {
          responseBody = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
          if (!responseBody) {
            // 如果不是 UTF-8 文本，返回 base64 编码
            responseBody = [data base64EncodedStringWithOptions:0];
          }
        }
        
        [FBLogger logFmt:@"✅ HTTP_REQUEST completed: status=%ld, bodySize=%ld", (long)statusCode, (long)(data ? data.length : 0)];
        dispatch_semaphore_signal(semaphore);
      }];
      [task resume];
    });
  }
  
  // 等待请求完成（最多等待 timeout + 5 秒）
  dispatch_time_t timeoutTime = dispatch_time(DISPATCH_TIME_NOW, (int64_t)((timeout + 5.0) * NSEC_PER_SEC));
  long result = dispatch_semaphore_wait(semaphore, timeoutTime);
  
  if (result != 0) {
    // 超时
    if (task) {
      [task cancel];
    }
    return FBResponseWithStatus([FBCommandStatus timeoutErrorWithMessage:[NSString stringWithFormat:@"HTTP request timeout after %.1f seconds", timeout] traceback:nil]);
  }
  
  if (requestError) {
    // 提供更详细的错误信息
    NSString *errorDomain = requestError.domain;
    NSInteger errorCode = requestError.code;
    NSString *errorDescription = requestError.localizedDescription;
    NSString *errorReason = requestError.localizedFailureReason ?: @"";
    NSString *errorSuggestion = requestError.localizedRecoverySuggestion ?: @"";
    
    // 根据错误类型提供更具体的诊断信息
    NSString *diagnosticInfo = @"";
    if ([errorDomain isEqualToString:NSURLErrorDomain]) {
      switch (errorCode) {
        case NSURLErrorNotConnectedToInternet:
          diagnosticInfo = @"设备未连接到互联网。请检查：1) WiFi/蜂窝数据是否开启 2) 网络连接是否正常";
          break;
        case NSURLErrorCannotFindHost:
          diagnosticInfo = [NSString stringWithFormat:@"无法解析主机名。请检查：1) DNS 是否正常 2) 域名 '%@' 是否正确", url.host];
          break;
        case NSURLErrorCannotConnectToHost:
          diagnosticInfo = [NSString stringWithFormat:@"无法连接到主机 '%@'。请检查：1) 主机是否可达 2) 端口是否正确 3) 防火墙设置", url.host];
          break;
        case NSURLErrorTimedOut:
          diagnosticInfo = @"请求超时。请检查：1) 网络速度 2) 服务器响应时间 3) 超时设置是否合理";
          break;
        case NSURLErrorNetworkConnectionLost:
          diagnosticInfo = @"网络连接丢失。请检查：1) 网络稳定性 2) WiFi 信号强度";
          break;
        case NSURLErrorDNSLookupFailed:
          diagnosticInfo = [NSString stringWithFormat:@"DNS 查询失败。请检查：1) DNS 服务器设置 2) 域名 '%@' 是否存在", url.host];
          break;
        default:
          diagnosticInfo = [NSString stringWithFormat:@"网络错误 (错误码: %ld, 域: %@)", (long)errorCode, errorDomain];
          break;
      }
    }
    
    NSString *fullErrorMessage = [NSString stringWithFormat:@"HTTP request failed: %@\n错误码: %ld\n错误域: %@\n原因: %@\n建议: %@\n诊断: %@",
                                  errorDescription,
                                  (long)errorCode,
                                  errorDomain,
                                  errorReason,
                                  errorSuggestion,
                                  diagnosticInfo];
    
    [FBLogger logFmt:@"❌ HTTP_REQUEST 详细错误: %@", fullErrorMessage];
    
    return FBResponseWithStatus([FBCommandStatus unknownErrorWithMessage:fullErrorMessage traceback:nil]);
  }
  
  return FBResponseWithObject(@{
    @"status": @(statusCode),
    @"headers": responseHeaders,
    @"body": responseBody
  });
}

+ (id<FBResponsePayload>)handleNetworkDiagnosis:(FBRouteRequest *)request
{
  // GET 请求的查询参数在 request.parameters 中
  NSString *testUrl = request.parameters[@"url"] ?: @"http://www.baidu.com";
  
  NSMutableDictionary *diagnosis = [NSMutableDictionary dictionary];
  
  // 测试基本连接
  NSURL *url = [NSURL URLWithString:testUrl];
  if (!url) {
    return FBResponseWithObject(@{
      @"error": @"Invalid test URL",
      @"url": testUrl
    });
  }
  
  diagnosis[@"testUrl"] = testUrl;
  diagnosis[@"host"] = url.host ?: @"";
  diagnosis[@"port"] = url.port ? @(url.port.integerValue) : @(url.scheme ? ([url.scheme isEqualToString:@"https"] ? 443 : 80) : 80);
  
  // 执行测试请求
  NSMutableURLRequest *testRequest = [NSMutableURLRequest requestWithURL:url];
  testRequest.HTTPMethod = @"HEAD";
  testRequest.timeoutInterval = 5.0;
  testRequest.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  [testRequest setValue:@"WebDriverAgent/1.0" forHTTPHeaderField:@"User-Agent"];
  
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block NSInteger statusCode = 0;
  __block NSError *testError = nil;
  __block BOOL completed = NO;
  
  // 使用 defaultSessionConfiguration（参考 photo-proxy 的实现）
  NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
  config.timeoutIntervalForRequest = 5.0;
  config.timeoutIntervalForResource = 5.0;
  config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
  
  NSURLSession *session = [NSURLSession sessionWithConfiguration:config];
  NSURLSessionDataTask *task = [session dataTaskWithRequest:testRequest completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    completed = YES;
    if (error) {
      testError = error;
    } else if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
      statusCode = ((NSHTTPURLResponse *)response).statusCode;
    }
    dispatch_semaphore_signal(semaphore);
  }];
  
  [task resume];
  
  // 等待最多 6 秒
  dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 6 * NSEC_PER_SEC);
  long result = dispatch_semaphore_wait(semaphore, timeout);
  
  if (result != 0) {
    // 超时
    [task cancel];
    diagnosis[@"status"] = @"timeout";
    diagnosis[@"message"] = @"请求超时（6秒）";
    diagnosis[@"connected"] = @NO;
  } else if (testError) {
    // 错误
    diagnosis[@"status"] = @"error";
    diagnosis[@"errorCode"] = @(testError.code);
    diagnosis[@"errorDomain"] = testError.domain;
    diagnosis[@"errorDescription"] = testError.localizedDescription;
    diagnosis[@"connected"] = @NO;
    
    // 提供诊断建议
    if ([testError.domain isEqualToString:NSURLErrorDomain]) {
      switch (testError.code) {
        case NSURLErrorNotConnectedToInternet:
          diagnosis[@"suggestion"] = @"设备未连接到互联网。请检查 WiFi 或蜂窝数据是否开启";
          break;
        case NSURLErrorCannotFindHost:
          diagnosis[@"suggestion"] = [NSString stringWithFormat:@"无法解析主机 '%@'。请检查 DNS 设置", url.host];
          break;
        case NSURLErrorCannotConnectToHost:
          diagnosis[@"suggestion"] = [NSString stringWithFormat:@"无法连接到主机 '%@'。请检查网络连接和防火墙设置", url.host];
          break;
        case NSURLErrorTimedOut:
          diagnosis[@"suggestion"] = @"连接超时。请检查网络速度或尝试其他 URL";
          break;
        default:
          diagnosis[@"suggestion"] = @"网络连接失败。请检查设备网络设置";
          break;
      }
    }
  } else {
    // 成功
    diagnosis[@"status"] = @"success";
    diagnosis[@"statusCode"] = @(statusCode);
    diagnosis[@"connected"] = @YES;
    diagnosis[@"message"] = @"网络连接正常";
  }
  
  diagnosis[@"completed"] = @(completed);
  
  return FBResponseWithObject(diagnosis);
}

@end
