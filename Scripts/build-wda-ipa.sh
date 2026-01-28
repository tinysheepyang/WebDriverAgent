#!/bin/bash
#
# Build WebDriverAgentRunner-Runner.app and package to WDA.ipa
# Steps follow the user's requested flow:
# 1) xcodebuild build-for-testing ...
# 2) cd DerivedData Products dir
# 3) mkdir Payload && cp -r *.app Payload
# 4) rm -rf Payload/WebDriverAgentRunner-Runner.app/Frameworks/XC*
# 5) zip -r WDA.ipa Payload
#
# Usage:
#   cd WebDriverAgent
#   bash Scripts/build-wda-ipa.sh
#
set -euo pipefail

DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-/tmp/derivedDataPath}"
CONFIGURATION="${CONFIGURATION:-Release}"
IPA_NAME="${IPA_NAME:-WDA.ipa}"
DEST_COMMANDS_DIR="/Users/cardloan/Documents/code/mobile-tools-new/commands"

# Resolve WebDriverAgent repo root from this script location,
# so the script works no matter where it is executed from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WDA_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROJECT="${WDA_ROOT}/WebDriverAgent.xcodeproj"
SCHEME="WebDriverAgentRunner"
SDK="iphoneos"

echo "[build-wda-ipa] Step 1/5: xcodebuild build-for-testing"
echo "[build-wda-ipa]   cleanup derivedDataPath before build"
rm -rf "${DERIVED_DATA_PATH}"
echo "[build-wda-ipa]   derivedDataPath: ${DERIVED_DATA_PATH}"
echo "[build-wda-ipa]   configuration : ${CONFIGURATION}"
echo "[build-wda-ipa]   scheme        : ${SCHEME}"
echo "[build-wda-ipa]   sdk           : ${SDK}"
echo "[build-wda-ipa]   wdaRoot       : ${WDA_ROOT}"
echo "[build-wda-ipa]   project       : ${PROJECT}"

if [[ ! -d "${WDA_ROOT}" ]]; then
  echo "[build-wda-ipa] ❌ WebDriverAgent root not found: ${WDA_ROOT}" >&2
  exit 1
fi
if [[ ! -d "${PROJECT}" ]]; then
  echo "[build-wda-ipa] ❌ Xcode project not found: ${PROJECT}" >&2
  exit 1
fi

cd "${WDA_ROOT}"

# -destination "generic/platform=iOS" 使真机构建不依赖已连接设备，对 iOS 26 / Xcode 26 更稳定
# ARCHS=arm64 与官方 build-real.sh 一致，避免多余架构导致签名/兼容问题
xcodebuild build-for-testing \
  -project "WebDriverAgent.xcodeproj" \
  -scheme "${SCHEME}" \
  -sdk "${SDK}" \
  -destination "generic/platform=iOS" \
  -configuration "${CONFIGURATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  CODE_SIGNING_ALLOWED=NO ARCHS=arm64

PRODUCTS_DIR="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-${SDK}"
if [[ ! -d "${PRODUCTS_DIR}" ]]; then
  echo "[build-wda-ipa] ❌ Products dir not found: ${PRODUCTS_DIR}" >&2
  exit 1
fi

echo "[build-wda-ipa] Step 2/5: cd ${PRODUCTS_DIR}"
cd "${PRODUCTS_DIR}"

echo "[build-wda-ipa] Step 3/5: create Payload and copy .app"
rm -rf Payload
mkdir -p Payload

shopt -s nullglob
APPS=( *.app )
shopt -u nullglob

if [[ ${#APPS[@]} -eq 0 ]]; then
  echo "[build-wda-ipa] ❌ No .app found in ${PRODUCTS_DIR}" >&2
  exit 1
fi

for app in "${APPS[@]}"; do
  echo "[build-wda-ipa]   cp -R ${app} -> Payload/"
  cp -R "${app}" "Payload/"
done

echo "[build-wda-ipa] Step 4/5: remove XC* in Frameworks"
FRAMEWORKS_DIR="Payload/WebDriverAgentRunner-Runner.app/Frameworks"
if [[ -d "${FRAMEWORKS_DIR}" ]]; then
  echo "[build-wda-ipa]   deleting: ${FRAMEWORKS_DIR}/XC*"
  rm -rf "${FRAMEWORKS_DIR}"/XC*
else
  echo "[build-wda-ipa] ⚠️ Frameworks dir not found (skipping): ${FRAMEWORKS_DIR}"
  echo "[build-wda-ipa]    (If app name differs, adjust FRAMEWORKS_DIR in this script.)"
fi

APP_PATH="Payload/WebDriverAgentRunner-Runner.app"
if [[ ! -d "${APP_PATH}" ]]; then
  echo "[build-wda-ipa] ❌ App not found: ${APP_PATH}" >&2
  exit 1
fi

echo "[build-wda-ipa] Step 5/5: zip to ${IPA_NAME}"
rm -f "${IPA_NAME}"
zip -r "${IPA_NAME}" Payload

echo "[build-wda-ipa] Step 6/6: copy IPA to commands directory"
if [[ ! -d "${DEST_COMMANDS_DIR}" ]]; then
  echo "[build-wda-ipa]   creating commands dir: ${DEST_COMMANDS_DIR}"
  mkdir -p "${DEST_COMMANDS_DIR}"
fi
cp -f "${IPA_NAME}" "${DEST_COMMANDS_DIR}/"
echo "[build-wda-ipa] ✅ Done:"
echo "  IPA:      ${PRODUCTS_DIR}/${IPA_NAME}"
echo "  Copied to ${DEST_COMMANDS_DIR}/${IPA_NAME}"
