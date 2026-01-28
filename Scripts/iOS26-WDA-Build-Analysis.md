# iOS 26 下 WDA 两种打包方式不可用原因分析

## 一、两种打包方式简述

| 脚本 | 输出 IPA | 主要差异 |
|------|----------|----------|
| `build-wda-ipa.sh` | `wda.ipa` | **删除** Frameworks 下 `XC*`（XCTest/XCUI* 等） |
| `build-wda-ipa-keep-xc.sh` | `lower-wda.ipa` | **保留** XCTest/XCUI*，不删除 |

两者都使用同一套 `xcodebuild build-for-testing` 流程，区别仅在打包前是否删除 XC* 框架。

---

## 二、在 iOS 26 / Xcode 26 上不可用的主要原因

### 1. 缺少 `-destination` 参数（影响最大）

**现状：**

当前两个脚本的 xcodebuild 命令为：

```bash
xcodebuild build-for-testing \
  -project "WebDriverAgent.xcodeproj" \
  -scheme "${SCHEME}" \
  -sdk "${SDK}" \                    # iphoneos
  -configuration "${CONFIGURATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}"
```

**问题：**

- `build-for-testing` 针对 **真机 (iphoneos)** 时，Xcode 需要知道“为哪类设备”构建。
- 未指定 `-destination` 时，Xcode 会尝试从“已连接设备 / 可用目标”里自动选一个。在 CI、无设备连接或 Xcode 26 逻辑变更时，可能：
  - 报错 “unable to find a destination”
  - 或选到不兼容 iOS 26 的旧 destination，导致构建/签名/安装链路上出问题。

**官方/社区做法：**

- WDA 官方 CI（如 `.github/workflows/wda-package.yml`）里，真机构建使用：
  ```bash
  -destination "generic/platform=iOS"
  ```
- 这样不依赖具体设备，适合“通用真机包”。

**结论：**  
在 iOS 26 / Xcode 26 上，**未传 `-destination "generic/platform=iOS"`** 是两种打包方式都可能失败的一个重要原因。

---

### 2. Xcode 26 / iOS 26 自身兼容性问题

**已知事实：**

- Appium 等社区已有反馈：**在 Xcode 26 上，integration app / 相关产物构建失败，报错来自 Xcode 侧**。
- 同一套工程用 **Xcode 15** 可以成功为 **iOS 26 模拟器** 构建并跑测试。
- WebDriverAgent 上游通过 PR #1032 增加 `-Wno-reserved-identifier` 等编译选项，用于缓解 Xcode 26 下的新告警/错误。

**可能原因归纳：**

- **编译器 / 静态分析更严**：Xcode 26 对 C/ObjC 的保留标识符、API 使用等检查更严，部分在旧 Xcode 下能过的代码会变成错误或必须改。
- **XCTest / 测试框架变更**：iOS 26 对应新版本 XCTest，接口、链接方式或依赖可能变化，导致“按旧方式”打出来的包在 iOS 26 设备上无法正确加载或运行。
- **SDK / 部署目标不匹配**：  
  - 工程里 `IPHONEOS_DEPLOYMENT_TARGET = 15.6`，  
  - 用 **iOS 26 SDK（Xcode 26）** 编译时，若存在已废弃或行为变化的 API，会在新 SDK 下暴露出来，从而在编译或运行阶段出问题。

因此，即便补上 `-destination`，**在“仅使用 Xcode 26 + iOS 26 SDK”这一前提下**，两种打包方式仍可能因为 Xcode 26 自身兼容性而不可用。

---

### 3. 未显式限制架构（ARCHS）

**现状：**

- 脚本未传 `ARCHS=arm64`。
- WDA 官方真机构建（如 `build-real.sh`）会加：`CODE_SIGNING_ALLOWED=NO ARCHS=arm64`。

**影响：**

- 在 M1/M2 Mac + Xcode 26 上，若不约束架构，可能打出带 x86_64（或多余架构）的包。
- iOS 设备只需 arm64；多架构或错误架构会带来签名、尺寸、兼容性等问题，在新系统上更容易被严格检查。

对“完全不能用”来说，这是次要因素，但会叠加在 1、2 之上。

---

### 4. 两种脚本在 iOS 26 上的差异说明

- **build-wda-ipa.sh（删 XC*）**  
  - 依赖设备侧已存在的 XCTest/XCUI*（由系统提供）。  
  - 在 iOS 26 上，若系统内建框架的版本、符号或加载方式有变，而 WDA 又是用旧 SDK/旧构建方式打的，容易出现“在设备上跑不起来”或“符号找不到”。

- **build-wda-ipa-keep-xc.sh（保留 XC*）**  
  - 把 XCTest/XCUI* 打进 ipa，理论上更不依赖系统版本，但在 Xcode 26 下：  
  - 若用的是 **iOS 26 SDK** 编译，而当前 WDA 代码/依赖尚未适配 Xcode 26，**构建阶段**就可能失败（编译器/链接器报错）；  
  - 若 Xcode 26 对“测试包内嵌 XCTest”有新的校验或限制，也会导致“打包能完成，但在 iOS 26 上不可用”。

因此：  
- **“不能用”** 既可能表现为：**根本构建失败**（尤其是 Xcode 26 下）；  
- 也可能表现为：**能打出 ipa，但在 iOS 26 设备上安装/启动/测机失败**。  
两种脚本都会受到上述 1～3 点影响，所以在“iOS 26 系统上都不能用”的结论是一致的。

---

## 三、建议的修复与规避措施

### 1. 脚本层面（两种打包方式都建议做）

- **补全 `-destination`**  
  - 在 `xcodebuild build-for-testing` 中增加：  
    `-destination "generic/platform=iOS"`  
  - 这样不依赖实机是否连接，行为与官方 CI 一致。

- **显式指定架构与签名行为**  
  - 建议传入：`ARCHS=arm64`，必要时可加 `CODE_SIGNING_ALLOWED=NO`（若你们是后处理签名或用本机已有配置，可酌情保留当前签名方式，但架构建议固定为 arm64）。

- **保持与官方脚本一致**  
  - 参考 `Scripts/ci/build-real.sh` 的 `-destination` 和 `ARCHS` 用法，尽量对齐。

### 2. 工程与 Xcode 版本

- **短期优先用 Xcode 15 为 iOS 26 设备/模拟器构建**  
  - 社区验证过：Xcode 15 可为 iOS 26 模拟器成功构建并运行。  
  - 若目标主要是“在 iOS 26 上能跑”，可先用 Xcode 15 打 ipa，再在 iOS 26 上安装测试。

- **长期适配 Xcode 26**  
  - 将 WebDriverAgent 更新到包含 PR #1032（或同等 `-Wno-reserved-identifier` 等）的上游版本。  
  - 在 Xcode 26 下打开工程，按新告警/错误逐项修：保留标识符、废弃 API、测试相关依赖等。  
  - 再在两种脚本中都加上 `-destination "generic/platform=iOS"` 和 `ARCHS=arm64`，用 Xcode 26 做一次完整构建与真机测试。

### 3. 针对“删 XC*”与“保留 XC*”的选择

- **iOS 15/16**：保留 XC*（`build-wda-ipa-keep-xc.sh`）通常更稳。  
- **iOS 17+**：删除 XC*（`build-wda-ipa.sh`）多数场景可用。  
- **iOS 26**：  
  - 先在 Xcode 15 + `-destination "generic/platform=iOS"` 下，分别打两种包，在 iOS 26 上实测；  
  - 若仍不可用，再排查是“构建失败”还是“安装/运行失败”，并对照上文“Xcode 26 / iOS 26 兼容性”和“架构/签名”逐项收窄范围。

---

## 四、小结表

| 原因类型 | 说明 | 影响两种脚本？ |
|----------|------|----------------|
| 未传 `-destination "generic/platform=iOS"` | 真机构建目标不明确，在无设备或 Xcode 26 下易失败 | 是 |
| Xcode 26 / iOS 26 SDK 兼容性 | 构建错误或产物在 iOS 26 上无法运行 | 是 |
| 未显式设置 `ARCHS=arm64` | 可能多架构/错误架构，影响签名与兼容 | 是 |
| 删/留 XC* 的差异 | 只影响“依赖系统框架”还是“自带框架”，不解决 Xcode 26 / destination 问题 | 两种都会受 1、2 影响 |

**结论：**  
两种打包方式在 iOS 26 上不可用，**主要原因**是：  
1）缺少 `-destination "generic/platform=iOS"`；  
2）Xcode 26 / iOS 26 的构建与运行兼容性尚未在现有脚本和工程配置中完全覆盖。  
建议先按“脚本增加 destination + ARCHS”，并用 Xcode 15 打 iOS 26 可用包；再在工程与工具链上逐步做 Xcode 26 的适配。
