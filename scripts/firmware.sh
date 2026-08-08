#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
idf_dir="${IDF_PATH:-${root_dir}/.tools/esp-idf}"
project_dir="${root_dir}/packages/esp32-hfp"

if [[ ! -f "${idf_dir}/export.sh" ]]; then
  echo "ESP-IDF is unavailable; run vp run firmware:bootstrap first" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${idf_dir}/export.sh" >/dev/null
export IDF_TOOLCHAIN="clang"

case "${1:-}" in
  configure)
    idf.py -C "${project_dir}" set-target esp32
    ;;
  build)
    idf.py -C "${project_dir}" build
    ;;
  lint)
    idf.py -C "${project_dir}" clang-check
    ;;
  *)
    echo "usage: $0 {configure|build|lint}" >&2
    exit 2
    ;;
esac
