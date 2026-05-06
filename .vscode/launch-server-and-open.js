const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8800;

// Simple static file server
const server = http.createServer((req, res) => {
    const normalizedUrl = req.url === "/" ? "/index.html" : req.url;
    let filePath;

    if (normalizedUrl.startsWith("/gml/")) {
        filePath = path.join(process.cwd(), "Area 1 neu", normalizedUrl.replace("/gml/", ""));
    } else {
        filePath = path.join(process.cwd(), "src", normalizedUrl);
    }

    const ext = path.extname(filePath);
    let contentType = "text/html";

    if (ext === ".js") contentType = "text/javascript";
    if (ext === ".css") contentType = "text/css";
    if (ext === ".json") contentType = "application/json";
    if (ext === ".gml" || ext === ".xml") contentType = "application/xml";

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