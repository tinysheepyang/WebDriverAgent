#!/bin/bash
#
# Build WebDriverAgentRunner-Runner.app and package to WDA.ipa
# Same as build-wda-ipa.sh BUT keeps XCTest/XCUI* frameworks.
#
# Steps:
# 1) xcodebuild build-for-testing ...
# 2) cd DerivedData Products dir
# 3) mkdir Payload && cp -r *.app Payload
# 4) (NOOP) keep Payload/WebDriverAgentRunner-Runner.app/Frameworks/XC*
# 5) zip -r WDA.ipa Payload
#
# Usage:
#   cd WebDriverAgent
#   bash Scripts/build-wda-ipa-keep-xc.sh
#
set -euo pipefail

DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-/tmp/derivedDataPath}"
CONFIGURATION="${CONFIGURATION:-Release}"
IPA_NAME="${IPA_NAME:-lower-wda.ipa}"
DEST_COMMANDS_DIR="/Users/cardloan/Documents/code/mobile-tools-new/commands"

# Resolve WebDriverAgent repo root from this script location,
# so the script works no matter where it is executed from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WDA_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROJECT="${WDA_ROOT}/WebDriverAgent.xcodeproj"
SCHEME="WebDriverAgentRunner"
SDK="iphoneos"

echo "[build-wda-ipa-keep-xc] Step 1/5: xcodebuild build-for-testing"
echo "[build-wda-ipa-keep-xc]   cleanup derivedDataPath before build"
rm -rf "${DERIVED_DATA_PATH}"
echo "[build-wda-ipa-keep-xc]   derivedDataPath: ${DERIVED_DATA_PATH}"
echo "[build-wda-ipa-keep-xc]   configuration : ${CONFIGURATION}"
echo "[build-wda-ipa-keep-xc]   scheme        : ${SCHEME}"
echo "[build-wda-ipa-keep-xc]   sdk           : ${SDK}"
echo "[build-wda-ipa-keep-xc]   wdaRoot       : ${WDA_ROOT}"
echo "[build-wda-ipa-keep-xc]   project       : ${PROJECT}"

if [[ ! -d "${WDA_ROOT}" ]]; then
  echo "[build-wda-ipa-keep-xc] ❌ WebDriverAgent root not found: ${WDA_ROOT}" >&2
  exit 1
fi
if [[ ! -d "${PROJECT}" ]]; then
  echo "[build-wda-ipa-keep-xc] ❌ Xcode project not found: ${PROJECT}" >&2
  exit 1
fi

cd "${WDA_ROOT}"

xcodebuild build-for-testing \
  -project "WebDriverAgent.xcodeproj" \
  -scheme "${SCHEME}" \
  -sdk "${SDK}" \
  -configuration "${CONFIGURATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}"

PRODUCTS_DIR="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-${SDK}"
if [[ ! -d "${PRODUCTS_DIR}" ]]; then
  echo "[build-wda-ipa-keep-xc] ❌ Products dir not found: ${PRODUCTS_DIR}" >&2
  exit 1
fi

echo "[build-wda-ipa-keep-xc] Step 2/5: cd ${PRODUCTS_DIR}"
cd "${PRODUCTS_DIR}"

echo "[build-wda-ipa-keep-xc] Step 3/5: create Payload and copy .app"
rm -rf Payload
mkdir -p Payload

shopt -s nullglob
APPS=( *.app )
shopt -u nullglob

if [[ ${#APPS[@]} -eq 0 ]]; then
  echo "[build-wda-ipa-keep-xc] ❌ No .app found in ${PRODUCTS_DIR}" >&2
  exit 1
fi

for app in "${APPS[@]}"; do
  echo "[build-wda-ipa-keep-xc]   cp -R ${app} -> Payload/"
  cp -R "${app}" "Payload/"
done

echo "[build-wda-ipa-keep-xc] Step 4/5: keep XCTest/XCUI* in Frameworks (no deletion)"
FRAMEWORKS_DIR="Payload/WebDriverAgentRunner-Runner.app/Frameworks"
if [[ -d "${FRAMEWORKS_DIR}" ]]; then
  echo "[build-wda-ipa-keep-xc]   keeping: ${FRAMEWORKS_DIR}/XC*"
else
  echo "[build-wda-ipa-keep-xc] ⚠️ Frameworks dir not found (skipping): ${FRAMEWORKS_DIR}"
  echo "[build-wda-ipa-keep-xc]    (If app name differs, adjust FRAMEWORKS_DIR in this script.)"
fi

APP_PATH="Payload/WebDriverAgentRunner-Runner.app"
if [[ ! -d "${APP_PATH}" ]]; then
  echo "[build-wda-ipa-keep-xc] ❌ App not found: ${APP_PATH}" >&2
  exit 1
fi

echo "[build-wda-ipa-keep-xc] Step 5/5: zip to ${IPA_NAME}"
rm -f "${IPA_NAME}"
zip -r "${IPA_NAME}" Payload

echo "[build-wda-ipa-keep-xc] Step 6/6: copy IPA to commands directory"
if [[ ! -d "${DEST_COMMANDS_DIR}" ]]; then
  echo "[build-wda-ipa-keep-xc]   creating commands dir: ${DEST_COMMANDS_DIR}"
  mkdir -p "${DEST_COMMANDS_DIR}"
fi
cp -f "${IPA_NAME}" "${DEST_COMMANDS_DIR}/"
echo "[build-wda-ipa-keep-xc] ✅ Done:"
echo "  IPA:      ${PRODUCTS_DIR}/${IPA_NAME}"
echo "  Copied to ${DEST_COMMANDS_DIR}/${IPA_NAME}"

