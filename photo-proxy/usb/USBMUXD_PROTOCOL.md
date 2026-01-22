# usbmuxd 协议实现说明

## 协议格式

### 消息头（16 字节）

```
Offset  Size  Type    Description
0       4     uint32  Length (小端序)
4       4     uint32  Version (通常为 1)
8       4     uint32  Message Type
12      4     uint32  Tag (请求标识)
```

### 消息类型

- `1`: Result - 响应消息
- `2`: Connect - 连接请求（已废弃）
- `8`: PlistPacket - Plist 格式的消息
- `9`: ListDevices - 列出设备
- `2` (新版本): Connect - 连接请求（使用 plist）

### ListDevices 消息

**请求**:
- Message Type: `9` (ListDevices)
- Payload: 空的 plist `{}`

**响应**:
- Message Type: `8` (PlistPacket)
- Payload: plist 格式，包含 `DeviceList` 数组

示例响应:
```xml
<plist>
  <dict>
    <key>DeviceList</key>
    <array>
      <dict>
        <key>DeviceID</key>
        <integer>1</integer>
        <key>MessageType</key>
        <string>Attached</string>
        <key>Properties</key>
        <dict>
          <key>SerialNumber</key>
          <string>00008110-001A29940120201E</string>
          <key>ProductID</key>
          <integer>4776</integer>
          <key>ConnectionSpeed</key>
          <integer>480000000</integer>
          <key>ConnectionType</key>
          <string>USB</string>
        </dict>
      </dict>
    </array>
  </dict>
</plist>
```

### Connect 消息

**请求**:
- Message Type: `2` (Connect) 或 `8` (PlistPacket)
- Payload: plist 格式
  ```xml
  <plist>
    <dict>
      <key>DeviceID</key>
      <integer>1</integer>
      <key>PortNumber</key>
      <integer>62078</integer>  <!-- 字节序转换后 -->
    </dict>
  </plist>
  ```

**响应**:
- Message Type: `1` (Result)
- Payload: plist 格式，包含 `Error` 字段（如果有错误）

**注意**: 
- PortNumber 需要字节序转换：`((port & 0xFF) << 8) | ((port >> 8) & 0xFF)`
- Connect 成功后，后续的数据传输通过同一个 usbmuxd socket
- 需要使用 Packet 消息类型进行数据传输（当前实现简化处理）

## 实现状态

- ✅ 消息序列化/反序列化
- ✅ ListDevices 消息
- ✅ Connect 消息（基础实现）
- ⏳ Packet 消息类型（用于数据传输，当前简化处理）

## 参考

- https://github.com/libimobiledevice/usbmuxd
- https://www.theiphonewiki.com/wiki/Usbmux
