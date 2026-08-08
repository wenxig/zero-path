#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tools_dir="${root_dir}/.tools"
vcpkg_dir="${tools_dir}/vcpkg"
vcpkg_commit="d92484ed3c5020c6679d095ad3e5add907887b62"

mkdir -p "${tools_dir}"
if [[ ! -d "${vcpkg_dir}/.git" ]]; then
  git clone --filter=blob:none https://github.com/microsoft/vcpkg.git "${vcpkg_dir}"
fi
git -C "${vcpkg_dir}" fetch --depth=1 origin "${vcpkg_commit}"
git -C "${vcpkg_dir}" checkout --detach "${vcpkg_commit}"
if [[ ! -x "${vcpkg_dir}/vcpkg" ]]; then
  "${vcpkg_dir}/bootstrap-vcpkg.sh" -disableMetrics
fi

echo "vcpkg pinned at ${vcpkg_commit}"
echo "Native prerequisites: brew install cmake ninja llvm vcpkg ccache"
