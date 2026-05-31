const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8800;

function getRequestPath(requestUrl) {
    const url = new URL(requestUrl, "http://localhost");
    return decodeURIComponent(url.pathname);
}

function resolveFilePath(requestedPath, srcRoot, repoRoot) {
    const sanitizedPath = requestedPath === "/" ? "/index.html" : requestedPath;
    const normalizedPath = sanitizedPath.replace(/^[\/]+/, "");
    let filePath = path.join(srcRoot, normalizedPath || "index.html");

    if (!fs.existsSync(filePath)) {
        filePath = path.join(repoRoot, normalizedPath || "index.html");
    }

    if (!fs.existsSync(filePath) && !path.extname(normalizedPath)) {
        filePath = path.join(srcRoot, "index.html");
    }

    return filePath;
}

// Simple static file server
const server = http.createServer((req, res) => {
    const srcRoot = path.join(process.cwd(), "src");
    const repoRoot = process.cwd();
    const requestPath = getRequestPath(req.url || "/");

    const filePath = resolveFilePath(requestPath, srcRoot, repoRoot);

    const ext = path.extname(filePath);
    let contentType = "text/html";

    if (ext === ".js") contentType = "text/javascript";
    if (ext === ".css") contentType = "text/css";
    if (ext === ".json") contentType = "application/json";

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end("File not found");
        } else {
            res.writeHead(200, { "Content-Type": contentType });
            res.end(content);
        }
    });
});

if (require.main === module) {
    // Start server
    server.listen(PORT, () => {
        const url = `http://localhost:${PORT}`;
        console.log(`Server running at ${url}`);
    });
}

module.exports = {
    getRequestPath,
    resolveFilePath
};