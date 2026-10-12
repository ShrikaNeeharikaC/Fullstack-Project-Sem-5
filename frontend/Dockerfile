# React (Vite) build, served as static files by nginx. The pages call the
# backend directly at http://localhost:3000 (see src/lib/auth.js), so compose
# publishes the backend on 3000.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
