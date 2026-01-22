# lockdownd 协议实现说明

## 协议格式

### 消息格式

```
[4 字节长度（大端序）][Plist Payload]
```

### 消息类型

所有消息都是 plist 格式，包含 `MessageType` 字段：

- `Hello` - 握手消息
- `PairRecord` - 配对记录
- `StartService` - 启动服务
- `Result` - 响应消息

### Hello 消息

**请求**:
```xml
<plist>
  <dict>
    <key>MessageType</key>
    <string>Hello</string>
    <key>ProgName</key>
    <string>photo-proxy</string>
    <key>ClientVersionString</key>
    <string>1.0.0</string>
  </dict>
</plist>
```

**响应**:
```xml
<plist>
  <dict>
    <key>MessageType</key>
    <string>Result</string>
    <key>EnableSessionSSL</key>
    <true/>  <!-- 如果需要 SSL -->
    <key>Error</key>
    <string>PairingDialogResponsePending</string>  <!-- 如果需要配对 -->
  </dict>
</plist>
```

### StartService 消息

**请求**:
```xml
<plist>
  <dict>
    <key>MessageType</key>
    <string>StartService</string>
    <key>Service</key>
    <string>com.xiaoying.photo-companion</string>
  </dict>
</plist>
```

**响应**:
```xml
<plist>
  <dict>
    <key>MessageType</key>
    <string>Result</string>
    <key>Port</key>
    <integer>12345</integer>  <!-- 服务端口 -->
    <key>Error</key>
    <string>...</string>  <!-- 如果有错误 -->
  </dict>
</plist>
```

## 配对记录

配对记录存储在以下位置：

1. `~/.config/libimobiledevice/{UDID}.plist` (libimobiledevice)
2. `~/Library/Preferences/com.apple.iTunes.{UDID}.plist` (iTunes)
3. `~/Library/Preferences/com.apple.iPod.{UDID}.plist` (iPod)

配对记录包含设备的信任信息，用于认证。

## 实现状态

- ✅ 消息序列化/反序列化（plist）
- ✅ Hello 握手消息
- ✅ PairRecord 处理（读取配对记录）
- ✅ StartService 消息
- ⏳ SSL 会话支持（如果需要）

## 注意事项

1. **设备信任**: 设备需要信任此电脑（在设备上点击"信任"）
2. **配对记录**: 如果设备已信任，配对记录会自动创建
3. **服务名称**: iOS Companion Service 的服务名称需要与 iOS 应用中的名称匹配
4. **端口**: lockdownd 默认端口是 62078

## 参考

- https://www.theiphonewiki.com/wiki/Lockdownd
- https://github.com/libimobiledevice/libimobiledevice
