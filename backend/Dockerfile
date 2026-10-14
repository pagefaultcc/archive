FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
ARG BUILD_ID=1
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM alpine:3.22 AS production
RUN apk add --no-cache ca-certificates wget python3 py3-pip \
    && pip install --no-cache-dir --break-system-packages telethon pycryptodome \
    && adduser -D -u 10001 app \
    && mkdir -p /var/lib/archive/uploads /app/scraper \
    && chown -R app:app /var/lib/archive /app/scraper
COPY 7zz /usr/local/bin/7zz
RUN chmod +x /usr/local/bin/7zz
COPY --chown=app:app scraper/ /app/scraper/
RUN chmod +x /app/scraper/tg_engine.py
USER app
COPY --from=build /out/api /app/api
EXPOSE 8080
ENTRYPOINT ["/app/api"]

FROM golang:1.25-alpine AS test
COPY 7zz /usr/local/bin/7zz
RUN chmod +x /usr/local/bin/7zz
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
CMD ["go", "test", "-p", "1", "./..."]
