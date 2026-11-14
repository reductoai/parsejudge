# Splits a PDF into one PDF per page, for uploads too large to split in the Worker's 128 MB.
# Uses pdf-lib, the same library the Worker uses, so page files are the same either way.
# Pinned by digest so a rebuild gets the same image; Dependabot bumps it.
FROM public.ecr.aws/docker/library/node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
COPY package.json package-lock.json server.mjs ./
RUN npm ci --omit=dev --no-audit --no-fund
# The node image's unprivileged user. The server only reads /app and listens on 8080.
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
