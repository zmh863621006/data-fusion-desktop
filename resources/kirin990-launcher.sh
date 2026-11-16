#!/bin/sh
# Dedicated Kirin 990 test variant. All changes apply to this process tree only.
set -eu

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
COMPAT_DIR="$APP_DIR/resources/compat/kirin990"

if [ "$(id -u)" -eq 0 ]; then
  printf '%s\n' '请使用当前桌面普通用户启动数据融合助手，不要使用 sudo。' >&2
  exit 1
fi
if [ ! -r "$COMPAT_DIR/libgbm.so.1" ] || [ ! -x "$APP_DIR/data-fusion.bin" ]; then
  printf '%s\n' '麒麟990兼容组件不完整，请重新安装完整的专项测试包。' >&2
  exit 1
fi
case "$COMPAT_DIR" in
  *:*) printf '%s\n' '安装目录不能包含冒号，请使用默认安装目录。' >&2; exit 1 ;;
esac

# A basename avoids LD_PRELOAD splitting an absolute path containing spaces.
# Private Mesa takes precedence over vendor Mali GBM; the system files stay intact.
LD_LIBRARY_PATH="$COMPAT_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
LD_PRELOAD="libgbm.so.1${LD_PRELOAD:+:$LD_PRELOAD}"
LIBGL_ALWAYS_SOFTWARE=1
DATA_FUSION_LINUX_COMPAT_VARIANT=kirin990-arm64
export LD_LIBRARY_PATH LD_PRELOAD LIBGL_ALWAYS_SOFTWARE DATA_FUSION_LINUX_COMPAT_VARIANT

# Old Mali GBM lacks interfaces used before Chromium creates its first window.
# Retain Chromium's sandbox while avoiding that driver's GPU rendering path.
exec "$APP_DIR/data-fusion.bin" --ozone-platform=x11 --disable-gpu --disable-gpu-compositing "$@"
