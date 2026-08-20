#!/bin/zsh -l

# 多项目需求池本地软件一键启动器（macOS）
# 请将本文件放在 requirement-pool 项目根目录，双击即可启动。
# 首次启动会自动安装依赖并执行生产构建；以后直接启动本地服务。

SCRIPT_DIR="${0:A:h}"
LOG_FILE="$SCRIPT_DIR/需求池启动日志.txt"
DATA_DIR="$HOME/Library/Application Support/requirement-pool-local"
HOST="${REQPOOL_HOST:-}"
PORT="${REQPOOL_PORT:-8080}"

exec > >(tee -a "$LOG_FILE") 2>&1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 兼容 nvm 安装的 Node.js。
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  source "$NVM_DIR/nvm.sh"
fi

pause_on_error() {
  echo
  echo "启动未完成。请将本窗口的完整输出，或以下日志文件发给 Claude："
  echo "$LOG_FILE"
  echo
  read "?按回车键关闭窗口..."
  exit 1
}

command_version() {
  if command -v "$1" >/dev/null 2>&1; then
    "$1" -v 2>&1
  else
    echo "不可用"
  fi
}

port_is_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

open_existing_service() {
  if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then
    echo "检测到需求池服务已经在运行，正在打开管理页..."
    open "http://127.0.0.1:$PORT"
    echo "管理页已打开。本启动器无需重复启动服务。"
    return 0
  fi
  return 1
}

echo "=================================================="
echo "多项目需求池 · 本地启动检查"
echo "时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "脚本：$0"
echo "项目目录：$SCRIPT_DIR"
echo "数据目录：$DATA_DIR"
echo "监听地址：${HOST:-（按系统设置决定）}　端口：$PORT"
echo "PATH：$PATH"
echo "Node.js：$(command_version node)"
echo "npm：$(command_version npm)"
echo "=================================================="

cd "$SCRIPT_DIR" || pause_on_error

if [[ ! -f "$SCRIPT_DIR/package.json" || ! -f "$SCRIPT_DIR/public/index.html" ]]; then
  echo "错误：启动脚本不在完整的 requirement-pool 项目根目录。"
  echo "请确认本文件旁边存在 package.json、src 和 public 文件夹。"
  pause_on_error
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 Node.js。请先安装 Node.js 22.13 或更高版本。"
  echo "推荐访问：https://nodejs.org/"
  pause_on_error
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "错误：npm 不可用。请修复 Node.js 安装或 PATH 后重试。"
  pause_on_error
fi

if ! node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && (b>13 || (b===13 && c>=0))) ? 0 : 1)' ; then
  echo "错误：当前 Node.js 版本低于 22.13。"
  echo "本软件使用 Node.js 内置 SQLite，请升级 Node.js 后重试。"
  pause_on_error
fi

if ! [[ "$PORT" =~ '^[0-9]+$' ]] || [[ "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
  echo "错误：REQPOOL_PORT 必须是 1—65535 的整数，当前值：$PORT"
  pause_on_error
fi

if open_existing_service; then
  echo
  read "?按回车键关闭此窗口（服务仍由原窗口运行）..."
  exit 0
fi

if port_is_busy; then
  echo "错误：端口 $PORT 已被其他程序占用，但不是可识别的需求池服务。"
  echo "你可以先关闭占用程序，或在终端中指定其他端口："
  echo "  REQPOOL_PORT=8081 \"$0\""
  pause_on_error
fi

mkdir -p "$DATA_DIR" || pause_on_error

# 首次运行或依赖清单变化后安装依赖。
if [[ ! -d "$SCRIPT_DIR/node_modules" || ! -x "$SCRIPT_DIR/node_modules/.bin/tsc" ]]; then
  echo
  echo "首次启动：正在安装项目依赖，请保持网络连接..."
  npm install || pause_on_error
fi

# 源码比产物新，或还没有生产产物时自动重建。
NEED_BUILD=0
if [[ ! -f "$SCRIPT_DIR/dist/cli.js" ]]; then
  NEED_BUILD=1
elif find "$SCRIPT_DIR/src" "$SCRIPT_DIR/scripts" -type f -newer "$SCRIPT_DIR/dist/cli.js" -print -quit 2>/dev/null | grep -q .; then
  NEED_BUILD=1
elif [[ "$SCRIPT_DIR/tsconfig.json" -nt "$SCRIPT_DIR/dist/cli.js" || "$SCRIPT_DIR/package.json" -nt "$SCRIPT_DIR/dist/cli.js" ]]; then
  NEED_BUILD=1
fi

if [[ $NEED_BUILD -eq 1 ]]; then
  echo
  echo "正在构建需求池本地软件..."
  npm run build || pause_on_error
fi

if [[ ! -f "$SCRIPT_DIR/dist/cli.js" ]]; then
  echo "错误：构建完成后仍未找到 dist/cli.js。"
  pause_on_error
fi

echo
echo "正在启动多项目需求池..."
echo "访问地址：http://127.0.0.1:$PORT"
echo "SQLite 数据目录：$DATA_DIR"
echo "请保持本窗口开启；按 Control-C 可停止服务。"
echo

# 仅在显式设置 REQPOOL_HOST 时传 --host；否则交给 CLI 读取数据库里的系统设置，
# 这样 UI 中配置的「允许局域网设备访问 + 0.0.0.0」重启后才会真正生效。
HOST_ARGS=()
[[ -n "$HOST" ]] && HOST_ARGS=(--host "$HOST")

node "$SCRIPT_DIR/dist/cli.js" start \
  "${HOST_ARGS[@]}" \
  --port "$PORT" \
  --data-dir "$DATA_DIR" \
  --open
STATUS=$?

echo
if [[ $STATUS -ne 0 ]]; then
  echo "需求池服务已退出，状态码：$STATUS"
  echo "请检查上方 Node.js、npm、端口、权限或数据库报错。"
  pause_on_error
else
  echo "需求池服务已正常退出。"
fi
