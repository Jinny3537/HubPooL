#!/bin/bash

# 需求池项目上传到 GitHub 脚本
# 使用方法：chmod +x upload-to-github.sh && ./upload-to-github.sh

set -e  # 遇到错误立即退出

echo "🚀 需求池项目 GitHub 上传助手"
echo "================================"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 检查 Git 是否已安装
echo -n "✓ 检查 Git... "
if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ Git 未安装${NC}"
    echo "请先安装 Git: https://git-scm.com/download"
    exit 1
fi
echo -e "${GREEN}已安装${NC}"

# 获取用户输入
echo ""
echo -e "${BLUE}📋 请输入以下信息：${NC}"
echo ""

read -p "GitHub 用户名: " github_username
read -p "仓库名称 (默认: requirement-pool): " repo_name
repo_name=${repo_name:-requirement-pool}

read -p "使用 SSH (s) 还是 HTTPS (h)? (默认: SSH): " protocol
protocol=${protocol:-s}

if [ "$protocol" = "h" ] || [ "$protocol" = "H" ]; then
    repo_url="https://github.com/${github_username}/${repo_name}.git"
    protocol_name="HTTPS"
else
    repo_url="git@github.com:${github_username}/${repo_name}.git"
    protocol_name="SSH"
fi

echo ""
echo -e "${YELLOW}将使用以下配置：${NC}"
echo "  • GitHub 用户名: $github_username"
echo "  • 仓库名称: $repo_name"
echo "  • 仓库 URL: $repo_url"
echo "  • 协议: $protocol_name"
echo ""

read -p "确认继续? (y/n): " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "已取消"
    exit 0
fi

echo ""
echo -e "${BLUE}🔧 开始上传流程...${NC}"
echo ""

# Step 1: 初始化仓库
echo -n "1️⃣  初始化 Git 仓库... "
if [ -d ".git" ]; then
    echo "（已初始化）"
else
    git init
    echo -e "${GREEN}完成${NC}"
fi

# Step 2: 配置 Git 用户信息
echo -n "2️⃣  配置 Git 用户信息... "
if [ -z "$(git config --global user.name)" ]; then
    read -p "请输入你的 Git 用户名: " git_name
    git config --global user.name "$git_name"
fi
if [ -z "$(git config --global user.email)" ]; then
    read -p "请输入你的 Git 邮箱: " git_email
    git config --global user.email "$git_email"
fi
echo -e "${GREEN}完成${NC}"

# Step 3: 检查 .gitignore
echo -n "3️⃣  检查 .gitignore... "
if [ ! -f ".gitignore" ]; then
    echo "✓ 文件已存在"
else
    echo "✓ 使用默认 .gitignore"
fi
echo -e "${GREEN}完成${NC}"

# Step 4: 添加文件
echo "4️⃣  添加文件到暂存区..."
git add .
echo -e "${GREEN}完成${NC}"

# Step 5: 创建初始提交
echo "5️⃣  创建初始提交..."
git commit -m "✨ Initial commit: Multi-project requirement pool system v0.1.4

Features:
- Project management with editing capabilities
- Advanced search, filter, and sort functionality
- Multi-view modes (Table, Card, Kanban)
- Batch operations support
- Modern UI with light theme design
- System settings with themes and preferences
- SQLite persistence
- REST API backend
- Git synchronization support
- Responsive design for all devices
- Comprehensive documentation

Technologies:
- Frontend: HTML5, CSS3, JavaScript (ES6+)
- Backend: Node.js, TypeScript, Fastify
- Database: SQLite3
- Build: tsup

Documentation:
- See GITHUB_UPLOAD_GUIDE.md for upload instructions
- See README_GITHUB.md for project overview
- See docs/ for detailed documentation" || true

echo -e "${GREEN}完成${NC}"

# Step 6: 添加远程仓库
echo "6️⃣  添加远程仓库..."
if git remote get-url origin &> /dev/null; then
    echo "（远程仓库已存在）"
    git remote set-url origin "$repo_url"
else
    git remote add origin "$repo_url"
fi
echo -e "${GREEN}完成${NC}"

# Step 7: 显示提交历史
echo ""
echo -e "${BLUE}📝 提交历史：${NC}"
git log --oneline -5 || true

echo ""
echo -e "${YELLOW}⚠️  下一步：${NC}"
echo ""
echo "1. 在 GitHub 上创建仓库:"
echo "   https://github.com/new?name=${repo_name}"
echo ""
echo "2. 确保仓库是空的（不要选择初始化选项）"
echo ""
echo "3. 推送代码到 GitHub:"
echo ""
if [ "$protocol" = "h" ] || [ "$protocol" = "H" ]; then
    echo "   git branch -M main"
    echo "   git push -u origin main"
else
    echo "   git branch -M main"
    echo "   git push -u origin main"
fi
echo ""
echo "4. 仓库 URL:"
echo "   https://github.com/${github_username}/${repo_name}"
echo ""

read -p "现在推送代码? (y/n): " push_confirm
if [ "$push_confirm" = "y" ] || [ "$push_confirm" = "Y" ]; then
    echo ""
    echo -e "${BLUE}推送到 GitHub...${NC}"

    # 重命名分支为 main
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    if [ "$current_branch" != "main" ]; then
        git branch -M main
    fi

    # 推送代码
    if git push -u origin main 2>&1; then
        echo ""
        echo -e "${GREEN}✅ 上传成功！${NC}"
        echo ""
        echo "仓库地址: ${GREEN}https://github.com/${github_username}/${repo_name}${NC}"
        echo ""
    else
        echo ""
        echo -e "${RED}❌ 推送失败${NC}"
        echo ""
        echo "可能的原因："
        echo "1. 仓库不存在 - 请在 GitHub 上创建仓库"
        echo "2. SSH 密钥不配置 - 请使用 HTTPS 或配置 SSH"
        echo "3. 权限不足 - 请检查 GitHub 权限设置"
        echo ""
        echo "手动推送命令:"
        echo "  git push -u origin main"
        exit 1
    fi
else
    echo ""
    echo -e "${YELLOW}已跳过推送。稍后可以使用以下命令推送：${NC}"
    echo "  git push -u origin main"
fi

echo ""
echo "================================"
echo -e "${GREEN}🎉 GitHub 上传配置完成！${NC}"
echo ""
