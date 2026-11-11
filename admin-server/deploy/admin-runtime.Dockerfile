# Exact official Node base already verified by the production service.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

# Standard XZ-compressed DEB validation; no npm dependencies or startup installs.
ARG DEBIAN_MIRROR=http://mirrors.tencentyun.com
RUN sed -i \
        -e "s|http://deb.debian.org/debian-security|${DEBIAN_MIRROR}/debian-security|g" \
        -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}/debian|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=1 -o Acquire::https::Timeout=20 -o Acquire::http::Timeout=20 -o Acquire::ForceIPv4=true -o Acquire::Languages=none update \
    && apt-get -o Acquire::Retries=1 -o Acquire::https::Timeout=20 -o Acquire::http::Timeout=20 -o Acquire::ForceIPv4=true install -y --no-install-recommends xz-utils \
    && rm -rf /var/lib/apt/lists/*

USER 18087:18087
