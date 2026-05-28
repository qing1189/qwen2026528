FROM node:18-alpine

WORKDIR /app

# 安装依赖
COPY package.json ./
RUN npm install --production

# 复制源码
COPY src/ ./src/
COPY frontend/ ./frontend/

# 默认端口
EXPOSE 3000

# 启动服务
CMD ["node", "src/index.js"]
