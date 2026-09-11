FROM node:22-bookworm
WORKDIR /app
# deps for @livekit/rtc-node, ffmpeg, prism-media
RUN apt-get update && apt-get install -y python3 make g++ ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
# Fix revoice.js LiveKit isConnected API change (0.13.20 vs newer)
RUN sed -i "s/this\.room\.isConnected()/typeof this.room.isConnected === 'function' ? this.room.isConnected() : !!this.room.isConnected/g" node_modules/revoice.js/src/Revoice.js || true
COPY . .
VOLUME ["/app/sounds"]
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "src/index.js"]
