# Xcode 控制台日志查看指南

## 📋 基本步骤

### 1. 打开控制台

#### 方法 A: 使用快捷键
- 按 `⌘ + Shift + Y` (Command + Shift + Y)
- 或者 `⌘ + 0` (Command + 0) 打开/关闭右侧面板

#### 方法 B: 使用菜单
- 菜单栏：**View** > **Debug Area** > **Show Debug Area**
- 或者：**View** > **Debug Area** > **Activate Console**

#### 方法 C: 使用工具栏按钮
- 点击 Xcode 底部工具栏的 **调试区域** 按钮（两个重叠的矩形图标）

### 2. 控制台位置

控制台通常显示在 Xcode 窗口的**底部**，分为两部分：
- **左侧**：变量查看器（Variables View）
- **右侧**：控制台（Console）

### 3. 查看日志

控制台会显示：
- ✅ **应用输出**：`NSLog()`, `print()`, `FBLogger` 等的输出
- ✅ **系统日志**：iOS 系统消息
- ✅ **错误信息**：崩溃、异常等
- ✅ **网络请求**：URLSession 的日志（如果启用）

## 🔍 针对 WebDriverAgent 的日志查看

### 1. 运行 WebDriverAgent

1. 在 Xcode 中选择 `WebDriverAgentRunner` scheme
2. 选择目标设备（真机或模拟器）
3. 点击 **运行** 按钮（▶️）或按 `⌘ + R`

### 2. 查看 WebDriverAgent 日志

控制台会显示：

```
[WebDriverAgent] ServerURLHere->http://192.168.1.100:8100<-ServerURLHere
[FBLogger] 📤 HTTP_REQUEST via WebDriverAgent: GET http://www.baidu.com
[FBLogger] ❌ HTTP_REQUEST failed: 似乎已断开与互联网的连接。
```

### 3. 过滤日志

#### 方法 A: 使用搜索框
- 在控制台底部有**搜索框**
- 输入关键词过滤，例如：
  - `HTTP_REQUEST` - 查看 HTTP 请求相关日志
  - `❌` - 查看错误日志
  - `✅` - 查看成功日志
  - `NSURLError` - 查看网络错误

#### 方法 B: 使用过滤器
- 点击控制台右上角的**过滤器图标**（漏斗图标）
- 可以选择：
  - **All Output** - 所有输出
  - **Debugger Output** - 调试器输出
  - **Target Output** - 目标输出

### 4. 清除日志

- 点击控制台右上角的**清除按钮**（垃圾桶图标）
- 或按 `⌘ + K` 清除控制台

## 📊 查看网络请求详细日志

### 1. 启用详细日志

WebDriverAgent 使用 `FBLogger` 记录日志，可以通过以下方式查看：

```objective-c
[FBLogger logFmt:@"📤 HTTP_REQUEST via WebDriverAgent: %@ %@", method, urlString];
[FBLogger logFmt:@"❌ HTTP_REQUEST failed: %@", error.localizedDescription];
```

### 2. 查看网络错误详情

在控制台中搜索以下关键词：
- `NSURLError` - 网络错误
- `-1009` - 错误代码
- `NSURLErrorDomain` - 错误域
- `HTTP request failed` - HTTP 请求失败

### 3. 查看系统网络日志

iOS 系统也会输出网络相关的日志，在控制台中可能显示为：
```
[Network] ... 
[CFNetwork] ...
```

## 🛠️ 高级技巧

### 1. 使用断点查看变量

1. 在代码中设置断点（点击行号左侧）
2. 运行程序，当执行到断点时暂停
3. 在**变量查看器**（左侧面板）中查看变量值
4. 在**控制台**中输入命令查看变量：
   ```lldb
   po urlString
   po requestError
   po error.localizedDescription
   ```

### 2. 使用 LLDB 命令

在控制台中可以输入 LLDB 命令：

```lldb
# 查看变量
po urlString
po requestError

# 查看对象详细信息
po [requestError description]

# 继续执行
continue
# 或
c

# 单步执行
step
# 或
s

# 查看调用栈
bt
```

### 3. 导出日志

1. 在控制台中右键点击
2. 选择 **Save Console Output...**
3. 保存为文本文件

### 4. 实时监控日志

控制台会实时显示日志，无需刷新。可以：
- 滚动查看历史日志
- 使用搜索框过滤特定内容
- 清除不需要的日志

## 📝 常见日志示例

### WebDriverAgent 启动日志
```
[WebDriverAgent] ServerURLHere->http://192.168.1.100:8100<-ServerURLHere
[FBLogger] Built at Dec 25 2024 10:30:00
```

### HTTP 请求日志
```
[FBLogger] 📤 HTTP_REQUEST via WebDriverAgent: GET http://www.baidu.com
[FBLogger] ❌ HTTP_REQUEST failed: 似乎已断开与互联网的连接。
[FBLogger] ❌ HTTP_REQUEST 详细错误: HTTP request failed: ...
```

### 网络错误日志
```
[Network] Connection failed: NSURLErrorDomain -1009
[CFNetwork] Failed to connect to host
```

## 🎯 针对当前问题的日志查看

### 1. 运行网络诊断
```bash
curl "http://localhost:8100/photos/network-diagnosis" | python3 -m json.tool
```

### 2. 在 Xcode 控制台查看
- 搜索 `HTTP_REQUEST` 或 `network-diagnosis`
- 查看是否有错误信息
- 查看错误代码和错误域

### 3. 查看系统网络日志
- 搜索 `NSURLError` 或 `-1009`
- 查看是否有系统级别的错误信息

## 💡 提示

1. **保持控制台打开**：运行 WebDriverAgent 时保持控制台可见
2. **使用搜索**：使用搜索框快速定位相关日志
3. **查看完整错误**：展开错误信息查看详细信息
4. **对比日志**：对比成功和失败的日志，找出差异

## 🔗 相关资源

- [Xcode Debugging Guide](https://developer.apple.com/documentation/xcode/debugging)
- [LLDB Command Reference](https://lldb.llvm.org/use/map.html)
- [WebDriverAgent Logging](https://github.com/appium/WebDriverAgent)
