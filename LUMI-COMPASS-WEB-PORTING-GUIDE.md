# LUMI Compass Web Porting Guide

This guide provides step-by-step instructions for porting MongoDB Compass Web to LUMI.

## Prerequisites

- Node.js >= 22.15.1
- npm >= 10.2.4

## Step 1: Verify Compatible Version

Before starting the porting process, you need to identify a compatible version of Compass that can be successfully built.

1. Clone the MongoDB Compass repository (if not already done):
   ```bash
   git clone https://github.com/mongodb-js/compass.git
   cd compass
   ```

2. Checkout a version tag to test:
   ```bash
   git checkout v1.46.8
   ```

3. Run the bootstrap command to verify the version builds successfully:
   ```bash
   npm run bootstrap
   ```

4. If the command completes successfully, the version is compatible and ready for porting.

**Note:** The current latest known working version is **v1.46.8**. If you need to test other versions, repeat steps 2-3 with different version tags.

## Step 2: Apply Modifications to Compass-Web

## Step 3: Build docker images

### Environment Configuration

Before building the Docker images, you need to configure the `.env` file in the `packages/compass-web` directory. The `.env` file controls various runtime settings for Compass Web.

Create or update `packages/compass-web/.env` with the following variables:

```env
COMPASS_WEB_HTTP_WEBPACK_DEV_SERVER_PORT=8080
COMPASS_WEBSOCKET_PROXY_PORT=8081
COMPASS_WEB_BASE_PATH=''
COMPASS_WEB_READ_ONLY=false
COMPASS_WEB_ENABLE_IMPORT_EXPORT=true
COMPASS_WEB_DIRECT_CONNECTION=true
COMPASS_WEBSOCKET_PROXY_URL='wss://compass.lumigame.com/wormhole'
COMPASS_WEB_DOCUMENTATION_LINK=https://git3.nexdev.net/l1/documentation/-/wikis/database/Compass-Web
COMPASS_WEB_LOGOUT_PATH=logout
```

**Note:** The build scripts automatically copy environment-specific `.env` files (e.g., `.env.lumi-local`, `.env.lumi-sit`, `.env.lumi-uat`) during the build process. You can create these files for different deployment environments.

### Building Docker Images

#### Build Proxy Image

The proxy image contains the WebSocket proxy service that handles WebSocket connections for Compass Web.

```bash
npm --workspace=@mongodb-js/compass-web run build:proxy
```

This command builds a Docker image tagged as `compass-web:proxy` using `Dockerfile.proxy`. The proxy service runs on port 8081.

#### Build Client Image

The client image contains the built Compass Web application served by nginx.

```bash
npm --workspace=@mongodb-js/compass-web run build:client:<target>
```

Replace `<target>` with one of the following supported targets:
- `lumi:local` - Builds client image for LUMI local environment
- `lumi:sit` - Builds client image for LUMI SIT environment
- `lumi:uat` - Builds client image for LUMI UAT environment

**Examples:**
```bash
# Build for LUMI local environment
npm --workspace=@mongodb-js/compass-web run build:client:lumi:local

# Build for LUMI SIT environment
npm --workspace=@mongodb-js/compass-web run build:client:lumi:sit

# Build for LUMI UAT environment
npm --workspace=@mongodb-js/compass-web run build:client:lumi:uat
```

Each client build command will:
1. Copy the appropriate environment-specific `.env` file to `.env`
2. Build the webpack bundle for the web target
3. Build the Docker image tagged as `compass-web:client-<target>`

The client image runs on port 8080 by default (nginx unprivileged port).