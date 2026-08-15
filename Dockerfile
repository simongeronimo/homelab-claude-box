FROM node:22-slim
WORKDIR /root/
RUN apt-get update && apt-get install -y --no-install-recommends git tmux ca-certificates curl jq && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
CMD ["sleep", "infinity"]
