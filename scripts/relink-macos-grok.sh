#!/usr/bin/env bash

set -euo pipefail
shopt -s nullglob

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_DIR="${ROOT}/gui/src-tauri"
DYLIB_NAME="libgrokj2k.1.dylib"
INSTALL_NAME="@executable_path/../Frameworks/${DYLIB_NAME}"
FRAMEWORKS_RPATH="@executable_path/../Frameworks"
STAGING_DIRECTORY="${TAURI_DIR}/homebrew-libraries"
SYSTEM_OR_BUNDLE_REFERENCE='^(/usr/lib/|/System/|@rpath/|@executable_path/|@loader_path/)'
BUILD_OR_HOMEBREW_PATH='/Users/runner|/opt/homebrew|/usr/local'

if [[ "${TAURI_ENV_DEBUG:-false}" == "true" ]]; then
    PROFILE_DIR="debug"
else
    PROFILE_DIR="release"
fi

STAGED_DYLIB="${TAURI_DIR}/${DYLIB_NAME}"
EXECUTABLES=(
    "${TAURI_DIR}/target/${PROFILE_DIR}/dcpscreen-gui"
)
FILES=("${STAGED_DYLIB}" "${EXECUTABLES[@]}")

for file in "${FILES[@]}"; do
    if [[ ! -f "${file}" ]]; then
        echo "relink-macos-grok: ${file} does not exist" >&2
        exit 1
    fi
done

# a binary linked against this dylib records whatever its id says
install_name_tool -id "${INSTALL_NAME}" "${STAGED_DYLIB}"

# the FFmpeg and mpv dylibs in Frameworks have @rpath install names
for executable in "${EXECUTABLES[@]}"
do
    if ! otool -l "${executable}" | grep -qF "path ${FRAMEWORKS_RPATH} ("
    then
        install_name_tool -add_rpath "${FRAMEWORKS_RPATH}" "${executable}"
    fi
done

# the bundle config names every staged library as a framework
for executable in "${EXECUTABLES[@]}"
do
    for reference in $(otool -L "${executable}" | awk -v system_or_bundle="${SYSTEM_OR_BUNDLE_REFERENCE}" 'NR > 1 && !/libgrok/ && $1 !~ system_or_bundle {print $1}')
    do
        name="$(basename "${reference}")"
        if [[ ! -f "${STAGING_DIRECTORY}/${name}" ]]
        then
            echo "relink-macos-grok: ${executable} loads ${reference}, which ${STAGING_DIRECTORY} does not carry" >&2
            exit 1
        fi
        install_name_tool -change "${reference}" "@rpath/${name}" "${executable}"
    done
done

for file in "${FILES[@]}"; do
    for reference in $(otool -L "${file}" | awk 'NR > 1 && /libgrok/ {print $1}'); do
        case "$(basename "${reference}")" in
            "${DYLIB_NAME}")
                install_name_tool -change "${reference}" "${INSTALL_NAME}" "${file}"
                ;;
            *)
                echo "relink-macos-grok: ${file} loads ${reference}, which the bundle does not carry" >&2
                exit 1
                ;;
        esac
    done
    # every install_name_tool edit breaks the signature arm64 requires
    codesign --force --sign - "${file}"
done

for file in "${FILES[@]}"; do
    if otool -L "${file}" | awk 'NR > 1 && /libgrok/ {print $1}' | grep -qv "^@executable_path/"; then
        otool -L "${file}" >&2
        echo "relink-macos-grok: ${file} still loads libgrokj2k from outside the bundle" >&2
        exit 1
    fi
done

for file in "${FILES[@]}" "${STAGING_DIRECTORY}"/*.dylib
do
    if otool -L "${file}" | awk 'NR > 1' | grep -E "${BUILD_OR_HOMEBREW_PATH}" >&2
    then
        echo "relink-macos-grok: ${file} loads a library from the build tree or Homebrew" >&2
        exit 1
    fi
done

echo "relink-macos-grok: the gui loads ${INSTALL_NAME}, searches ${FRAMEWORKS_RPATH} and loads nothing from Homebrew"
