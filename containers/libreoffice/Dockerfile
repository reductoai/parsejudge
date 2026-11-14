# DOCX/PPTX -> PDF with LibreOffice, for self-hosted parsejudge. Same HTTP contract as the hosted converter:
# POST /convert with the document as the body and its MIME type as content-type; the response is the PDF.
FROM public.ecr.aws/docker/library/debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 libreoffice-writer-nogui libreoffice-impress-nogui \
    fonts-dejavu fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
# Build the LibreOffice user profile once so requests copy it instead of initializing a new one. A file is sent
# through Writer and then Impress so both are set up; after that, a conversion leaves the profile unchanged.
RUN mkdir /tmp/warmup && cd /tmp/warmup && echo warmup > warmup.txt \
  && soffice -env:UserInstallation=file:///opt/libreoffice-profile --headless --convert-to pdf warmup.txt \
  && soffice -env:UserInstallation=file:///opt/libreoffice-profile --headless \
    --infilter=impress_pdf_import --convert-to pptx warmup.pdf \
  && test -f warmup.pptx \
  && cd / && rm -rf /tmp/warmup
COPY server.py /server.py
EXPOSE 8080
CMD ["python3", "/server.py"]
