#!/bin/zsh -l

# 多项目需求池一键构建器（macOS）
# 双击即可执行 npm run build，构建 dist/ 产物。
# 构建后需重启需求池服务才能让后端改动生效；前端改动只需浏览器硬刷新。

SCRIPT_DIR="${0:A:h}"
LOG_FILE="$SCRIPT_DIR/构建日志.txt"

exec > >(tee -a "$LOG_FILE") 2>&1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 兼容 nvm 安装的 Node.js。
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  source "$NVM_DIR/nvm.sh"
fi

pause() {
  echo
  read "?按回车键关闭窗口..."
  exit 0
}

pause_on_error() {
  echo
  echo "构建未完成。请将本窗口的完整输出，或以下日志文件发给 Claude："
  echo "$LOG_FILE"
  pause
}

command_version() {
  if command -v "$1" >/dev/null 2>&1; then
    "$1" -v 2>&1
  else
    echo "不可用"
  fi
}

echo "=================================================="
echo "多项目需求池 · 一键构建"
echo "时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "项目目录：$SCRIPT_DIR"
echo "Node.js：$(command_version node)"
echo "npm：$(command_version npm)"
echo "=================================================="

cd "$SCRIPT_DIR" || pause_on_error

if [[ ! -f "$SCRIPT_DIR/package.json" ]]; then
  echo "错误：未找到 package.json，请确认本文件在项目根目录。"
  pause_on_error
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 Node.js。请先安装 Node.js 22.13 或更高版本。"
  pause_on_error
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "错误：npm 不可用。"
  pause_on_error
fi

# 依赖检查：首次或 node_modules 缺失时自动安装
if [[ ! -d "$SCRIPT_DIR/node_modules" || ! -x "$SCRIPT_DIR/node_modules/.bin/tsc" ]]; then
  echo
  echo "正在安装项目依赖，请保持网络连接..."
  npm install || pause_on_error
fi

echo
echo "正在构建（npm run build = tsc + postbuild）..."
echo

npm run build
STATUS=$?

echo
if [[ $STATUS -eq 0 ]]; then
  echo "=================================================="
  echo "✅ 构建成功！dist/ 已更新。"
  echo ""
  echo "让改动生效："
  echo "  · 后端改动（src/）→ 关闭原启动器窗口，重新双击「启动需求池.command」"
  echo "  · 前端改动（public/）→ 浏览器硬刷新（Cmd-Shift-R），无需重启服务"
  echo "=================================================="
else
  echo "=================================================="
  echo "❌ 构建失败，状态码：$STATUS"
  echo "请检查上方报错信息。"
  echo "=================================================="
  pause_on_error
fi

pause
