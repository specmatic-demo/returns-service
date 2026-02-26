FROM node:24

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN git clone https://github.com/specmatic-demo/central-contract-repository /app/.specmatic/repos/central-contract-repository

ENV RETURNS_HOST=0.0.0.0
ENV RETURNS_PORT=9012

EXPOSE 9012
CMD ["npm", "run", "start"]
