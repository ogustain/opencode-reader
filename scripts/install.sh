#!/usr/bin/env bash
# Installs the reader into the plugins/ folder of OpenCode config folders.
# OpenCode loads every package placed there, server and TUI halves, without a
# config entry, so no config file is edited.
set -euo pipefail

NAME=opencode-reader
REPO_URL=https://github.com/ogustain/opencode-reader.git

usage() {
  cat <<'EOF'
usage: scripts/install.sh [--link | --ref <branch|tag> | --uninstall] [--target <dir>]...

  (default)     copy the main branch from GitHub
  --ref <ref>   copy this branch or tag instead
  --link        link this checkout instead of copying (to develop the reader)
  --uninstall   remove the reader from the targets
  --target dir  OpenCode config folder, repeat for several
                (default: $OPENCODE_CONFIG_DIR, else ~/.config/opencode)
EOF
}

die() { echo "error: $*" >&2; exit 1; }

mode=copy
ref=main
targets=()
while [ $# -gt 0 ]; do
  case $1 in
    --link) mode="link" ;;
    --uninstall) mode="uninstall" ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; ref=$2; shift ;;
    --target) [ $# -ge 2 ] || die "--target needs a value"; targets+=("$2"); shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
[ ${#targets[@]} -gt 0 ] || targets=("${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}")

# A path we may replace: our own link or copy, never a folder we did not install.
ours() {
  [ -L "$1" ] || grep -qs "\"name\": \"$NAME\"" "$1/package.json"
}

source_dir=
case $mode in
  link)
    source_dir=$(cd "$(dirname "$0")/.." && pwd)
    ours "$source_dir" || die "$source_dir is not an $NAME checkout"
    ;;
  copy)
    command -v git >/dev/null || die "git is required"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    git clone --quiet --depth 1 --branch "$ref" "$REPO_URL" "$tmp/$NAME" || die "cannot clone $REPO_URL at $ref"
    source_dir=$tmp/$NAME
    ;;
esac

for target in "${targets[@]}"; do
  dest=$target/plugins/$NAME
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    ours "$dest" || die "$dest exists and is not $NAME; move it away first"
  fi
  case $mode in
    uninstall)
      rm -rf "$dest"
      rmdir "$target/plugins" 2>/dev/null || true
      echo "removed $dest"
      continue
      ;;
    link)
      mkdir -p "$target/plugins"
      rm -rf "$dest"
      ln -s "$source_dir" "$dest"
      echo "linked $dest -> $source_dir"
      ;;
    copy)
      mkdir -p "$target/plugins"
      rm -rf "$dest"
      cp -R "$source_dir" "$dest"
      echo "copied $NAME $(git -C "$dest" rev-parse --short HEAD) ($ref) to $dest"
      ;;
  esac
  for config in "$target/opencode.json" "$target/opencode.jsonc"; do
    if grep -qs "$NAME" "$config"; then
      echo "warning: $config also declares $NAME; remove that entry or the reader loads twice" >&2
    fi
  done
done

echo "Restart OpenCode to load the change (opencode service restart)."
