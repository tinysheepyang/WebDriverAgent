#!/bin/bash
set -euo pipefail

# ==== 配置（对应 iOS App Signer UI）====
INPUT_IPA="/Users/cardloan/Documents/code/mobile-tools-new/commands/WDA.ipa"
OUTPUT_IPA="/Users/cardloan/Documents/code/mobile-tools-new/commands/new_WDA.ipa"

SIGN_IDENTITY='Apple Development: huihui zhu (6M8S6L57HU)'   # Signing Certificate
PROFILE="/path/to/Your_6M8S6L57HU_profile.mobileprovision"  # Provisioning Profile
NEW_APP_ID="com.facebook.WebDriverAgentRunner.xyautotest"   # New Application ID（可不改）

# ==== 下面基本固定，不用动 ====
WORK_DIR="$(mktemp -d /tmp/wda-sign-XXXXXX)"
IPADIR="${WORK_DIR}/ipa"
APPDIR=""
echo "Work dir: ${WORK_DIR}"

# 1) 解包 ipa
mkdir -p "${IPADIR}"
unzip -q "${INPUT_IPA}" -d "${IPADIR}"

# 2) 找到 Payload 里的 .app
APPDIR="$(cd "${IPADIR}/Payload" && find . -maxdepth 1 -type d -name "*.app" | head -n 1)"
APPDIR="${IPADIR}/Payload/${APPDIR#./}"
echo "App: ${APPDIR}"

# 3) 替换 embedded.mobileprovision
if [[ -n "${PROFILE}" && -f "${PROFILE}" ]]; then
  cp -f "${PROFILE}" "${APPDIR}/embedded.mobileprovision"
fi

# 4) 如需要，修改 CFBundleIdentifier
if [[ -n "${NEW_APP_ID}" ]]; then
  /usr/bin/plutil -replace CFBundleIdentifier -string "${NEW_APP_ID}" "${APPDIR}/Info.plist"
fi

# 5) 从 profile 提取 entitlements
ENT_PLIST="${WORK_DIR}/entitlements.plist"
/usr/bin/security cms -D -i "${PROFILE}" > "${WORK_DIR}/profile.plist"
/usr/bin/plutil -extract Entitlements xml1 -o "${ENT_PLIST}" "${WORK_DIR}/profile.plist"

# 6) 先签 Frameworks / PlugIns，再签主 app
if [[ -d "${APPDIR}/Frameworks" ]]; then
  find "${APPDIR}/Frameworks" -maxdepth 1 \( -name "*.framework" -o -name "*.dylib" \) | while read f; do
    /usr/bin/codesign --force --sign "${SIGN_IDENTITY}" --timestamp=none "${f}"
  done
fi

if [[ -d "${APPDIR}/PlugIns" ]]; then
  find "${APPDIR}/PlugIns" -maxdepth 2 -name "*.xctest" | while read p; do
    /usr/bin/codesign --force --sign "${SIGN_IDENTITY}" --timestamp=none --entitlements "${ENT_PLIST}" "${p}"
  done
fi

# 主 app
/usr/bin/codesign --force --sign "${SIGN_IDENTITY}" --timestamp=none --entitlements "${ENT_PLIST}" "${APPDIR}"

# 7) 重新打包 ipa
rm -f "${OUTPUT_IPA}"
( cd "${IPADIR}" && zip -qr "${OUTPUT_IPA}" Payload )
mv "${IPADIR}/${OUTPUT_IPA##*/}" "${OUTPUT_IPA}"

echo "✅ Re-signed IPA: ${OUTPUT_IPA}"