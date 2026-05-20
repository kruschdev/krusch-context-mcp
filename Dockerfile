FROM node:22-alpine

WORKDIR /app

# Copy package.json and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Expose port if necessary (not usually needed for stdio MCP servers, but good practice if it uses SSE)
EXPOSE 4890

# Set user to non-root
USER node

# Start the application
CMD ["npm", "start"]
