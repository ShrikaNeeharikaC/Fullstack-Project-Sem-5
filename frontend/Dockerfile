# React (Vite) build, served as static files by nginx. Vite reads VITE_API_URL
# at build time; src/lib/auth.js uses localhost:3000 as the local fallback.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
