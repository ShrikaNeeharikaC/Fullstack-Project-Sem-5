# Official Playwright image: Node + Linux deps + bundled Chromium, Firefox and
# WebKit (the cross-browser test uses Firefox/WebKit). The tag must match the
# playwright version in package-lock.json, or the bundled browsers won't load.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The code launches installed Google Chrome (channel: "chrome"), which the
# image doesn't include. Chrome for Linux is amd64-only.
RUN npx playwright install --with-deps chrome

COPY src ./src

ENV NODE_ENV=production \
    PORT=3000 \
    CRAWL_HEADLESS=true \
    HEADLESS=true

EXPOSE 3000
CMD ["node", "src/server.js"]
