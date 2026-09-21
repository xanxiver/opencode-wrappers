#!/usr/bin/env sh

set -eu

repo_dir=".repos/park-ui"
repo_url="https://github.com/chakra-ui/park-ui"

if [ -d "$repo_dir/.git" ]; then
  exit 0
fi

mkdir -p ".repos"
git clone "$repo_url" "$repo_dir"
