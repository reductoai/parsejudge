"""Converts DOCX and PPTX to PDF with headless LibreOffice. One soffice per request, each with its own profile.

The profile is a copy of one built in the image (see the Dockerfile), so soffice doesn't initialize a new one on
every request. It's a copy rather than shared because soffice locks its profile and requests can run at once.
"""

import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EXTENSIONS = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
}
PROFILE = "/opt/libreoffice-profile"
TIMEOUT_SECONDS = 300


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.reply(200 if self.path == "/ping" else 404, b"ok", "text/plain")

    def do_POST(self) -> None:
        extension = EXTENSIONS.get(self.headers.get("content-type", ""))
        if self.path != "/convert" or extension is None:
            return self.reply(415, b"Expected a DOCX or PPTX body on POST /convert", "text/plain")
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        with tempfile.TemporaryDirectory() as work:
            source = os.path.join(work, f"document.{extension}")
            with open(source, "wb") as file:
                file.write(body)
            shutil.copytree(PROFILE, os.path.join(work, "profile"))
            result = subprocess.run(
                [
                    "soffice",
                    f"-env:UserInstallation=file://{work}/profile",
                    "--headless",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    work,
                    source,
                ],
                capture_output=True,
                timeout=TIMEOUT_SECONDS,
            )
            pdf = os.path.join(work, "document.pdf")
            if result.returncode != 0 or not os.path.exists(pdf):
                return self.reply(422, result.stderr or b"Conversion failed", "text/plain")
            with open(pdf, "rb") as file:
                self.reply(200, file.read(), "application/pdf")

    def reply(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
