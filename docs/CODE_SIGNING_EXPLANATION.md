# WebDriverAgent 多次代码签名原因解析

## 🔍 为什么需要多次 codesign 签名？

### 项目结构

WebDriverAgent 项目包含**多个独立的 target**，它们之间存在**依赖关系**：

```
WebDriverAgent 项目
├── WebDriverAgentLib (Framework)
│   └── 包含核心功能代码
│   └── 需要签名 #1
│
└── WebDriverAgentRunner (UI Test Bundle)
    └── 依赖于 WebDriverAgentLib
    └── 需要签名 #2
```

### 签名顺序

当编译 `WebDriverAgentRunner` scheme 时，Xcode 会：

1. **第一步：编译并签名 WebDriverAgentLib**
   - 这是一个 Framework（`.framework`）
   - 需要独立的代码签名
   - 签名后的 Framework 会被嵌入到 Runner 中

2. **第二步：编译并签名 WebDriverAgentRunner**
   - 这是一个 UI 测试 Bundle（`.xctest`）
   - 依赖于已签名的 WebDriverAgentLib
   - 需要自己的代码签名
   - 同时需要验证嵌入的 Framework 签名

### 具体原因

#### 1. **依赖关系**
```
WebDriverAgentRunner (依赖) → WebDriverAgentLib
```
- Runner 需要链接 WebDriverAgentLib Framework
- Framework 必须先编译和签名
- Runner 才能使用已签名的 Framework

#### 2. **不同的产品类型**
- **WebDriverAgentLib**: `com.apple.product-type.framework`
- **WebDriverAgentRunner**: `com.apple.product-type.bundle.ui-testing`

不同的产品类型需要不同的签名配置。

#### 3. **iOS 安全机制**
- iOS 要求所有可执行代码都必须签名
- Framework 和 Bundle 都是独立的代码单元
- 每个都需要自己的签名
- 嵌入的 Framework 也需要有效签名

#### 4. **签名配置可能不同**
从项目配置可以看到：

**WebDriverAgentLib**:
- 可能使用不同的签名身份
- 可能使用不同的 Provisioning Profile

**WebDriverAgentRunner**:
- 使用测试 bundle 的签名配置
- 需要匹配的 Bundle Identifier
- 需要测试设备的 Provisioning Profile

## 📋 签名过程详解

### 真机签名流程

```
1. 编译 WebDriverAgentLib
   ↓
2. codesign WebDriverAgentLib.framework
   - 使用配置的签名身份
   - 使用 Provisioning Profile
   ↓
3. 编译 WebDriverAgentRunner
   - 链接已签名的 WebDriverAgentLib
   ↓
4. codesign WebDriverAgentRunner.xctest
   - 签名 Runner Bundle
   - 验证嵌入的 Framework 签名
   - 使用测试 bundle 的签名配置
```

### 模拟器签名流程

对于模拟器，可以禁用签名：
```bash
CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO
```

但 Xcode 仍然会执行签名步骤（使用 ad-hoc 签名），只是不需要证书。

## 🔧 如何优化签名次数？

### 方案 1: 使用自动签名（推荐）

在 Xcode 中：
1. 选择 Target → Signing & Capabilities
2. 勾选 "Automatically manage signing"
3. Xcode 会自动处理所有依赖的签名

### 方案 2: 统一签名配置

确保所有 target 使用相同的：
- Development Team
- Code Sign Identity
- Provisioning Profile（如果可能）

### 方案 3: 禁用不必要的签名

对于模拟器构建，可以禁用签名：
```bash
xcodebuild ... CODE_SIGNING_ALLOWED=NO
```

### 方案 4: 使用 xcconfig 文件

创建统一的签名配置：
```xcconfig
// LocalSigning.xcconfig
DEVELOPMENT_TEAM = Y8LRQ27V4E
CODE_SIGN_STYLE = Automatic
```

## ⚠️ 常见问题

### Q: 为什么签名这么慢？

**A:** 每次签名都需要：
- 验证证书有效性
- 检查 Provisioning Profile
- 计算代码哈希
- 生成签名数据

### Q: 可以只签名一次吗？

**A:** 不可以。因为：
- Framework 和 Bundle 是独立的代码单元
- iOS 要求每个都必须签名
- 依赖关系决定了签名顺序

### Q: 如何加快签名速度？

**A:** 
1. 使用自动签名（减少配置时间）
2. 缓存 Provisioning Profile
3. 使用本地证书（避免网络验证）
4. 对于开发，使用模拟器（可以禁用签名）

### Q: 签名失败怎么办？

**A:** 检查：
1. 证书是否有效
2. Provisioning Profile 是否匹配
3. Bundle Identifier 是否正确
4. 设备是否已注册
5. 签名配置是否一致

## 📊 签名配置检查清单

- [ ] WebDriverAgentLib 的签名配置
- [ ] WebDriverAgentRunner 的签名配置
- [ ] Development Team 是否一致
- [ ] Provisioning Profile 是否有效
- [ ] Bundle Identifier 是否正确
- [ ] 设备是否已添加到 Provisioning Profile

## 🎯 总结

**多次签名是正常的，因为：**

1. ✅ 项目有多个独立的 target
2. ✅ 它们之间存在依赖关系
3. ✅ iOS 要求每个代码单元都必须签名
4. ✅ 签名顺序由依赖关系决定

这是 iOS 开发的标准流程，不是问题，而是安全机制的要求。
