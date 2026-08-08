#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
brew_prefix="$(brew --prefix)"
export ZERO_PATH_LLVM_ROOT="${ZERO_PATH_LLVM_ROOT:-${brew_prefix}/opt/llvm}"
export ZERO_PATH_CCACHE="${ZERO_PATH_CCACHE:-${brew_prefix}/opt/ccache/bin}"
export ZERO_PATH_NINJA="${ZERO_PATH_NINJA:-$(command -v ninja)}"
export VCPKG_ROOT="${VCPKG_ROOT:-${root_dir}/.tools/vcpkg}"
export PATH="${ZERO_PATH_LLVM_ROOT}/bin:${ZERO_PATH_CCACHE}:$(dirname "${ZERO_PATH_NINJA}"):${PATH}"

if [[ ! -x "${VCPKG_ROOT}/vcpkg" && ! -x "${brew_prefix}/bin/vcpkg" ]]; then
  echo "vcpkg is unavailable; run vp run native:bootstrap first" >&2
  exit 1
fi

case "${1:-}" in
  configure)
    cmake --fresh --preset native-debug
    ;;
  build)
    cmake --build --preset native-debug
    ;;
  test)
    cmake --build --preset native-debug
    ctest --preset native-debug
    ;;
  sanitize)
    cmake --fresh --preset native-sanitize
    cmake --build --preset native-sanitize
    ctest --preset native-sanitize
    ;;
  lint)
    cmake --fresh --preset native-debug
    cmake --build --preset native-debug
    while IFS= read -r -d '' source_file; do
      clang-tidy -p "${root_dir}/build/native/native-debug" \
        --config-file "${root_dir}/.clang-tidy" \
        --header-filter "${root_dir}/packages/(audio-protocol|serial-bridge)/.*" \
        "${source_file}"
    done < <(find "${root_dir}/packages/audio-protocol" "${root_dir}/packages/serial-bridge" \
      -type f -name '*.cpp' -print0)
    ;;
  format)
    find "${root_dir}/packages/audio-protocol" "${root_dir}/packages/serial-bridge" \
      -type f \( -name '*.cpp' -o -name '*.hpp' \) -print0 |
      xargs -0 -r clang-format -i
    ;;
  format-check)
    find "${root_dir}/packages/audio-protocol" "${root_dir}/packages/serial-bridge" \
      -type f \( -name '*.cpp' -o -name '*.hpp' \) -print0 |
      xargs -0 -r clang-format --dry-run --Werror
    ;;
  *)
    echo "usage: $0 {configure|build|test|sanitize|lint|format|format-check}" >&2
    exit 2
    ;;
esac
