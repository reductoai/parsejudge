# DOCX/PPTX -> PDF with LibreOffice, for self-hosted parsejudge. Same HTTP contract as the hosted converter:
# POST /convert with the document as the body and its MIME type as content-type; the response is the PDF.
# Pinned by digest so a rebuild gets the same image; Dependabot bumps it.
FROM public.ecr.aws/docker/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 libreoffice-writer-nogui libreoffice-impress-nogui \
    fonts-dejavu fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
COPY server.py /server.py
EXPOSE 8080
# LibreOffice runs as an unprivileged user. Each request uses its own temp dir and profile; the home is only for
# whatever caches LibreOffice or fontconfig want to write. Anything built into /opt for the converter (such as a
# prebuilt LibreOffice profile, created as root and 0700) has to be readable by this user.
RUN useradd --system --create-home --shell /usr/sbin/nologin converter && chmod -R a+rX /opt
USER converter
CMD ["python3", "/server.py"]
