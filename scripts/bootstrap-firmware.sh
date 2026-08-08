#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tools_dir="${root_dir}/.tools"
idf_dir="${tools_dir}/esp-idf"
idf_version="v6.0.2"

mkdir -p "${tools_dir}"
if [[ ! -d "${idf_dir}/.git" ]]; then
  git clone --depth=1 --branch "${idf_version}" --recursive https://github.com/espressif/esp-idf.git "${idf_dir}"
fi
git -C "${idf_dir}" fetch --depth=1 origin "${idf_version}"
git -C "${idf_dir}" checkout --detach "${idf_version}"
git -C "${idf_dir}" submodule update --init --recursive --depth=1

"${idf_dir}/install.sh" esp32
"${idf_dir}/tools/idf_tools.py" install esp-clang esp-clang-libs

echo "ESP-IDF ${idf_version} installed"
echo "Run: source ${idf_dir}/export.sh"
