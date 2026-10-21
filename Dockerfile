FROM node:22-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS build
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build
FROM node:22-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY hub/requirements.txt /opt/requirements.txt
RUN python3 -m venv /opt/hub && /opt/hub/bin/pip install --no-cache-dir -r /opt/requirements.txt
WORKDIR /app
COPY --from=build /build/dist ./dist
COPY server ./server
COPY hub/hub.py ./hub/hub.py
RUN mkdir /data /music && chown node:node /data
USER node
ENV WIZARD_MUSIC_APP_HOST=0.0.0.0 WIZARD_MUSIC_APP_PORT=9205 WIZARD_MUSIC_HUB_HOME=/data WIZARD_MUSIC_LIBRARY=/music WIZARD_MUSIC_PYTHON=/opt/hub/bin/python WIZARD_MUSIC_HUB_ORIGIN=http://127.0.0.1:8793
EXPOSE 9205
HEALTHCHECK --interval=15s --timeout=5s CMD node -e "fetch('http://127.0.0.1:9205/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","server/launch.mjs"]
