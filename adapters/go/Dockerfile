# Go 接入适配器镜像：静态二进制 + 最小运行镜像。
FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/adapter .

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/adapter /usr/local/bin/adapter

EXPOSE 3002
ENTRYPOINT ["/usr/local/bin/adapter"]
