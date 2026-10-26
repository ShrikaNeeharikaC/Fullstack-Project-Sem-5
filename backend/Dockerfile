# Official Playwright image: Node + Linux deps + bundled Chromium, Firefox and
# WebKit (the cross-browser test uses Firefox/WebKit). The tag must match the
# playwright version in package-lock.json, or the bundled browsers won't load.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The Playwright base image includes the matching bundled Chromium and its
# system dependencies. Use that browser to avoid downloading Chrome at build time.

COPY src ./src

ENV NODE_ENV=production \
    PORT=3000 \
    CRAWL_HEADLESS=true \
    HEADLESS=true

EXPOSE 3000
CMD ["node", "src/server.js"]
