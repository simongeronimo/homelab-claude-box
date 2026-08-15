FROM node:22-slim
WORKDIR /root/
RUN apt-get update && apt-get install -y --no-install-recommends git tmux ca-certificates curl jq gh && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
COPY bin/ /usr/local/bin/
RUN chmod +x /usr/local/bin/start-session
CMD ["sleep", "infinity"]
