# Official Playwright image: Node + Linux deps + bundled Chromium, Firefox and
# WebKit (the cross-browser test uses Firefox/WebKit). The tag must match the
# playwright version in package-lock.json, or the bundled browsers won't load.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

<<<<<<< HEAD
# The code launches installed Google Chrome (channel: "chrome"), which the
# image doesn't include. Chrome for Linux is amd64-only. Ubuntu packages are
# fetched over HTTPS (the image's Azure mirror is HTTP-only): some networks'
# proxies corrupt plain-HTTP apt downloads ("Hash Sum mismatch").
RUN sed -i -e 's|http://azure.archive.ubuntu.com|https://archive.ubuntu.com|g' \
      -e 's|http://\(.*\)ubuntu.com|https://\1ubuntu.com|g' /etc/apt/sources.list.d/ubuntu.sources \
 && npx playwright install --with-deps chrome
=======
# The Playwright base image includes the matching bundled Chromium and its
# system dependencies. Use that browser to avoid downloading Chrome at build time.
>>>>>>> dc149461daf964b130adcb987ac9bd8ea240e9f8

COPY src ./src

ENV NODE_ENV=production \
    PORT=3000 \
    CRAWL_HEADLESS=true \
    HEADLESS=true

EXPOSE 3000
CMD ["node", "src/server.js"]
