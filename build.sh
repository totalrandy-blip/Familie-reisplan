#!/bin/sh
# Rebuilds app.js from src/app.js. Only needed after changing src/app.js.
cd "$(dirname "$0")" && npm install --silent && npx esbuild src/app.js --bundle --format=esm --minify --target=es2020 --outfile=app.js
