const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8800;

// Simple static file server
const server = http.createServer((req, res) => {
    const sanitizedPath = decodeURIComponent(req.url === "/" ? "/index.html" : req.url);
    const requestedPath = sanitizedPath.replace(/^[\/]+/, "");
    const srcRoot = path.join(process.cwd(), "src");
    const repoRoot = process.cwd();

    let filePath = path.join(srcRoot, requestedPath || "index.html");
    if (!fs.existsSync(filePath)) {
        filePath = path.join(repoRoot, requestedPath);
    }

    const ext = path.extname(filePath);
    let contentType = "text/html";

    if (ext === ".js") contentType = "text/javascript";
    if (ext === ".css") contentType = "text/css";
    if (ext === ".json") contentType = "application/json";
    if (ext === ".b3dm") contentType = "application/octet-stream";

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

// Start server
server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Server running at ${url}`);
});