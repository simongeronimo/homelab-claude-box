FROM node:22-slim
WORKDIR /root/
RUN apt-get update && apt-get install -y --no-install-recommends git tmux ca-certificates curl jq gh && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

# Skills every session on this box should have. Pinned rather than tracking
# main: these are instructions Claude follows, so a rebuild must never quietly
# change how sessions behave, and an upstream compromise must not land here on
# its own. Bump the version to update.
#
# They go to /opt, not /root/.claude/skills, because the dataset mounts over
# /root at runtime and would hide anything baked in there. bin/serve copies
# them across once that mount exists.
ARG PONYTAIL_VERSION=v4.9.0
RUN git clone --depth 1 --branch "$PONYTAIL_VERSION" \
      https://github.com/DietrichGebert/ponytail /tmp/ponytail \
    && mkdir -p /opt/skills \
    && cp -r /tmp/ponytail/skills/. /opt/skills/ \
    && rm -rf /tmp/ponytail

COPY bin/ /usr/local/bin/
RUN chmod +x /usr/local/bin/start-session /usr/local/bin/serve /usr/local/bin/usage
COPY app/ /app/
EXPOSE 8080
CMD ["serve"]
